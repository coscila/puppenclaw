import { generateKeyPairSync, randomUUID, X509Certificate } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { createServer, request, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { join } from "node:path";

export const CLAUDE_OAUTH_HOST = "platform.claude.com";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const MAX_BYTES = 64 * 1024;
const SCOPES = new Set(["org:create_api_key", "user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload", "user:plugins", "user:projects:read", "user:projects:write"]);
type RefreshReply = { status: number; body: Buffer };
export type OAuthRefreshTransport = (body: Buffer, signal: AbortSignal) => Promise<RefreshReply>;
type Scope = { id: string; active: () => boolean };

// Native Claude remains the credential owner. This transport only restores its
// fixed OAuth refresh endpoint inside the metered network namespace; it never
// reads profiles, writes tokens, or creates model/usage receipts.
export class ClaudeOAuthRelay {
  private readonly connections = new Set<Duplex>();
  private readonly recent = new Map<string, number[]>();
  private readonly globalRecent: number[] = [];
  private inFlight = 0;
  private constructor(readonly certificatePath: string, private readonly key: string, private readonly cert: string,
    private readonly forward: OAuthRefreshTransport) {
  }
  static async open(root: string, transport: OAuthRefreshTransport = refreshUpstream): Promise<ClaudeOAuthRelay> {
    const key = () => generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
    const issuerKey = key(), leafKey = key(), id = randomUUID().replaceAll("-", "");
    const certificatePath = join(root, `claude-oauth-${id}.pem`), csrPath = join(root, `claude-oauth-${id}.csr`), extensionsPath = join(root, `claude-oauth-${id}.ext`);
    try {
      const ca = await openssl(issuerKey, ["req", "-new", "-x509", "-key", "/dev/stdin", "-sha256", "-days", "3650", "-subj", "/CN=OCSL native Claude OAuth", "-addext", `subjectAltName=DNS:${CLAUDE_OAUTH_HOST}`, "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,keyCertSign", "-addext", `nameConstraints=critical,permitted;DNS:${CLAUDE_OAUTH_HOST},excluded;IP:0.0.0.0/0.0.0.0,excluded;IP:::/::`]);
      const csr = await openssl(leafKey, ["req", "-new", "-key", "/dev/stdin", "-subj", `/CN=${CLAUDE_OAUTH_HOST}`]);
      await writeFile(certificatePath, ca, { mode: 0o400, flag: "wx" });
      await writeFile(csrPath, csr, { mode: 0o400, flag: "wx" });
      await writeFile(extensionsPath, `subjectAltName=DNS:${CLAUDE_OAUTH_HOST}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n`, { mode: 0o400, flag: "wx" });
      const leaf = await openssl(issuerKey, ["x509", "-req", "-in", csrPath, "-CA", certificatePath, "-CAkey", "/dev/stdin", "-set_serial", `0x${id}`, "-sha256", "-days", "3650", "-extfile", extensionsPath]);
      const parsed = new X509Certificate(leaf), issuer = new X509Certificate(ca);
      if (parsed.ca || parsed.checkHost(CLAUDE_OAUTH_HOST) !== CLAUDE_OAUTH_HOST || !issuer.ca || !parsed.verify(issuer.publicKey)) throw new Error("Invalid OAuth relay certificate.");
      // Only the leaf key remains live after issuance. The constrained public
      // CA is trusted by the native subtree; neither key is persisted.
      return new ClaudeOAuthRelay(certificatePath, leafKey, leaf, transport);
    } catch (error) { await unlink(certificatePath).catch(() => {}); throw error; }
    finally { await Promise.all([csrPath, extensionsPath].map((path) => unlink(path).catch(() => {}))); }
  }
  static accepts(authority: string | undefined): boolean {
    return authority?.toLowerCase() === `${CLAUDE_OAUTH_HOST}:443`;
  }
  connect(socket: Duplex, head: Buffer, scope: Scope): void {
    if (!scope.active() || this.connections.size >= 16) { socket.destroy(); return; }
    this.connections.add(socket);
    const server: Server = createServer({ key: this.key, cert: this.cert, minVersion: "TLSv1.2", ALPNProtocols: ["http/1.1"], handshakeTimeout: 10_000,
      SNICallback: (name, callback) => { if (name !== CLAUDE_OAUTH_HOST) callback(new Error("OAuth TLS authority mismatch.")); else callback(null); },
    }, (req, res) => { void this.handle(req, res, scope).catch(() => this.reply(res, 502, { error: "oauth_transport_unavailable" })); });
    server.requestTimeout = 45_000; server.headersTimeout = 10_000; server.maxHeadersCount = 20;
    server.on("secureConnection", (tls) => { if (tls.servername !== CLAUDE_OAUTH_HOST) tls.destroy(); });
    server.on("clientError", (_error, peer) => peer.destroy());
    server.on("tlsClientError", (_error, peer) => peer.destroy());
    server.on("connect", (_req, peer) => peer.destroy());
    server.on("upgrade", (_req, peer) => peer.destroy());
    const deadline = setTimeout(() => socket.destroy(), 45_000); deadline.unref();
    socket.once("close", () => { clearTimeout(deadline); this.connections.delete(socket); server.closeAllConnections(); server.removeAllListeners(); });
    socket.on("error", () => socket.destroy());
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.unshift(head);
    server.emit("connection", socket);
  }
  private reply(res: ServerResponse, status: number, body: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    const bytes = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close", "content-length": bytes.length }); res.end(bytes);
  }
  private async handle(req: IncomingMessage, res: ServerResponse, scope: Scope): Promise<void> {
    const hosts = req.rawHeaders.filter((_v, i) => i % 2 === 0 && req.rawHeaders[i]?.toLowerCase() === "host");
    if (!scope.active()) { this.reply(res, 409, { error: "oauth_attempt_closed" }); return; }
    if (req.method !== "POST" || req.url !== "/v1/oauth/token" || hosts.length !== 1 || ![CLAUDE_OAUTH_HOST, `${CLAUDE_OAUTH_HOST}:443`].includes(req.headers.host?.toLowerCase() ?? "") ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(req.headers["content-type"] ?? "") || req.headers["content-encoding"] !== undefined) {
      this.reply(res, 403, { error: "oauth_route_denied" }); return;
    }
    if (Number(req.headers["content-length"] ?? 0) > MAX_BYTES) { this.reply(res, 413, { error: "invalid_refresh_request" }); return; }
    const now = Date.now();
    for (const [id, times] of this.recent) if (times.at(-1)! < now - 60_000) this.recent.delete(id);
    const times = (this.recent.get(scope.id) ?? []).filter((at) => at > now - 60_000);
    while (this.globalRecent[0] !== undefined && this.globalRecent[0] <= now - 60_000) this.globalRecent.shift();
    if (this.inFlight >= 4 || times.length >= 6 || this.globalRecent.length >= 60) { this.reply(res, 429, { error: "oauth_refresh_busy" }); return; }
    times.push(now); this.recent.set(scope.id, times); this.globalRecent.push(now); this.inFlight++;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
    const disconnected = () => { if (!res.writableFinished) controller.abort(); }; res.once("close", disconnected);
    try {
      const bytes = await limited(req, MAX_BYTES);
      let data: unknown; try { data = JSON.parse(bytes.toString("utf8")); } catch { this.reply(res, 400, { error: "invalid_refresh_request" }); return; }
      if (!validRefresh(data)) { this.reply(res, 400, { error: "invalid_refresh_request" }); return; }
      if (!scope.active() || controller.signal.aborted) { this.reply(res, 409, { error: "oauth_attempt_closed" }); return; }
      const reply = await this.forward(Buffer.from(JSON.stringify(data)), controller.signal);
      if (!scope.active() || controller.signal.aborted) { this.reply(res, 409, { error: "oauth_attempt_closed" }); return; }
      if (reply.body.length > MAX_BYTES || ![200, 400, 401, 403, 429, 503].includes(reply.status)) throw new Error("Invalid OAuth response.");
      const result: unknown = JSON.parse(reply.body.toString("utf8"));
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid OAuth response.");
      const record = result as Record<string, unknown>;
      if (reply.status === 200) {
        if (!secretString(record.access_token) || !Number.isFinite(record.expires_in) || Number(record.expires_in) <= 0 || (record.refresh_token !== undefined && !secretString(record.refresh_token))) throw new Error("Invalid OAuth response.");
        this.reply(res, reply.status, result);
      } else {
        const error = typeof record.error === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(record.error) ? record.error : "oauth_refresh_rejected";
        this.reply(res, reply.status, { error, error_description: "Claude OAuth refresh was rejected." });
      }
    } catch { this.reply(res, controller.signal.aborted ? 504 : 502, { error: "oauth_transport_unavailable" }); }
    finally { clearTimeout(timer); res.removeListener("close", disconnected); this.inFlight--; }
  }
  async close(): Promise<void> { for (const socket of this.connections) socket.destroy(); this.connections.clear(); await unlink(this.certificatePath).catch(() => {}); }
}
function secretString(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 8192 && !/[\r\n\x00]/u.test(value); }
function validRefresh(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return Object.keys(data).every((key) => ["grant_type", "refresh_token", "client_id", "scope", "expires_in"].includes(key)) && data.grant_type === "refresh_token" && data.client_id === CLIENT_ID && secretString(data.refresh_token) &&
    typeof data.scope === "string" && data.scope.length <= 2048 && data.scope.split(" ").every((scope) => SCOPES.has(scope)) &&
    (data.expires_in === undefined || Number.isSafeInteger(data.expires_in) && Number(data.expires_in) > 0 && Number(data.expires_in) <= 31_536_000);
}
async function limited(stream: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of stream) { size += part.length; if (size > limit) throw new Error("OAuth message exceeds limit."); parts.push(Buffer.from(part)); }
  return Buffer.concat(parts);
}
async function refreshUpstream(body: Buffer, signal: AbortSignal): Promise<RefreshReply> {
  return new Promise((resolve, reject) => {
    // https.request has no redirect behavior and this fixed origin never uses
    // the sandbox proxy or caller-controlled URL/header/CA configuration.
    const req = request({ hostname: CLAUDE_OAUTH_HOST, port: 443, path: "/v1/oauth/token", method: "POST", servername: CLAUDE_OAUTH_HOST, rejectUnauthorized: true, agent: false, signal,
      headers: { "content-type": "application/json", "content-length": body.length, "user-agent": "ocsl-native-oauth-relay/1" },
    }, (res) => { void limited(res, MAX_BYTES).then((bytes) => resolve({ status: res.statusCode ?? 502, body: bytes }), reject); });
    req.on("error", reject); req.end(body);
  });
}
async function openssl(key: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // The key exists only for this daemon lifetime. A long leaf validity avoids
    // introducing a new artificial expiry into continuously running studies.
    // Node's piped child stdin is a socket, which OpenSSL cannot reopen through
    // /dev/stdin. The fixed pipeline provides a real anonymous pipe; neither
    // the shell program nor argv/environment contains any key material.
    const child = spawn("sh", ["-c", 'cat | exec "$@"', "ocsl-oauth-certificate", "openssl", ...args], { stdio: ["pipe", "pipe", "ignore"], detached: true });
    const stop = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
    const timer = setTimeout(stop, 5000); let output = "";
    child.stdout.on("data", (part) => { output += String(part); if (output.length > MAX_BYTES) stop(); });
    child.on("error", () => { clearTimeout(timer); reject(new Error("OAuth relay certificate creation failed.")); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error("OAuth relay certificate creation failed.")); });
    child.stdin.on("error", () => {}); child.stdin.end(key);
  });
}
