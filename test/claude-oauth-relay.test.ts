import { createServer, request, type Server } from "node:http";
import { connect } from "node:tls";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_OAUTH_HOST, ClaudeOAuthRelay, type OAuthRefreshTransport } from "../src/advanced/claude-oauth-relay.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const refresh = { grant_type: "refresh_token", refresh_token: "synthetic-refresh", client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", scope: "user:profile user:inference" };
const success = { access_token: "synthetic-access", refresh_token: "synthetic-renewed", expires_in: 3600, scope: refresh.scope };
async function fixture(transport?: OAuthRefreshTransport) {
  const root = await mkdtemp(join(tmpdir(), "ocsl-auth-relay-"));
  const calls: unknown[] = [];
  const relay = await ClaudeOAuthRelay.open(root, transport ?? (async (body) => { calls.push(JSON.parse(body.toString())); return { status: 200, body: Buffer.from(JSON.stringify(success)) }; }));
  const scope = { id: "claude-attempt", active: true };
  const server = createServer(); const socketPath = join(root, "control.sock");
  server.on("connect", (req, socket, head) => { if (!ClaudeOAuthRelay.accepts(req.url)) { socket.destroy(); return; } relay.connect(socket, head, { id: scope.id, active: () => scope.active }); });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(async () => { await relay.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  return { root, relay, calls, scope, socketPath, cert: await readFile(relay.certificatePath) };
}
function call(f: Awaited<ReturnType<typeof fixture>>, body: unknown = refresh, options: { method?: string; path?: string; host?: string; sni?: string; authority?: string; trust?: boolean; rawBody?: string; extraHeaders?: string } = {}): Promise<{ status: number; body: any; headers: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: f.socketPath, method: "CONNECT", path: options.authority ?? `${CLAUDE_OAUTH_HOST}:443` });
    const timer = setTimeout(() => { req.destroy(); reject(new Error("fixture timeout")); }, 5000);
    req.once("error", (error) => { clearTimeout(timer); reject(error); });
    req.on("connect", (_res, socket, head) => {
      if (head.length) socket.unshift(head);
      const tls = connect({ socket, servername: options.sni ?? CLAUDE_OAUTH_HOST, ...(options.trust === false ? {} : { ca: f.cert }), rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] });
      const parts: Buffer[] = [];
      tls.on("error", (error) => { clearTimeout(timer); reject(error); });
      tls.on("data", (part) => parts.push(part));
      tls.once("end", () => { clearTimeout(timer); const raw = Buffer.concat(parts).toString(); const split = raw.indexOf("\r\n\r\n"); if (split < 0) { reject(new Error("no HTTP response")); return; } try { resolve({ status: Number(raw.split(" ")[1]), headers: raw.slice(0, split), body: JSON.parse(raw.slice(split + 4)) }); } catch (error) { reject(error); } });
      tls.once("secureConnect", () => { const data = options.rawBody ?? JSON.stringify(body); tls.write(`${options.method ?? "POST"} ${options.path ?? "/v1/oauth/token"} HTTP/1.1\r\nHost: ${options.host ?? CLAUDE_OAUTH_HOST}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(data)}\r\n${options.extraHeaders ?? ""}Connection: close\r\n\r\n${data}`); });
    });
    req.end();
  });
}
describe("scoped native Claude OAuth relay", () => {
  it("refreshes through verified exact-host TLS with only the constrained public CA on disk", async () => {
    const f = await fixture(); expect((await call(f)).body).toEqual(success); expect(f.calls).toEqual([refresh]);
    expect(new X509Certificate(f.cert).ca).toBe(true); expect(new X509Certificate(f.cert).subjectAltName).toBe("DNS:platform.claude.com");
    expect((await stat(f.relay.certificatePath)).mode & 0o777).toBe(0o400);
    expect(await readdir(f.root)).toHaveLength(2);
    for (const name of await readdir(f.root)) expect(name).not.toMatch(/key/);
    expect(f.cert.toString()).not.toMatch(/PRIVATE KEY|synthetic/);
  });
  it.each([
    { method: "GET" }, { path: "/v1/messages" }, { path: "/v1/oauth/token?x=1" },
    { path: "https://api.anthropic.com/v1/messages" }, { path: "/v1/oauth/%74oken" }, { host: "api.anthropic.com" }, { extraHeaders: "Content-Encoding: gzip\r\n" },
  ])("denies any other HTTP route or authority: %j", async (options) => {
    const f = await fixture(); expect((await call(f, refresh, options)).status).toBe(403); expect(f.calls).toEqual([]);
  });
  it.each([
    { grant_type: "authorization_code" }, { client_id: "unapproved" }, { model: "claude" }, { scope: "user:arbitrary" }, { refresh_token: "" },
  ])("rejects non-refresh payloads without dispatch: %j", async (change) => {
    const f = await fixture(); expect((await call(f, { ...refresh, ...change })).status).toBe(400); expect(f.calls).toEqual([]);
  });
  it("requires the bound certificate and exact TLS/CONNECT names", async () => {
    const f = await fixture(); await expect(call(f, refresh, { trust: false })).rejects.toThrow();
    await expect(call(f, refresh, { sni: "api.anthropic.com" })).rejects.toThrow();
    await expect(call(f, refresh, { sni: "" })).rejects.toThrow();
    await expect(call(f, refresh, { authority: "api.anthropic.com:443" })).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it("rejects oversized input without forwarding or accepting another route", async () => {
    const f = await fixture();
    expect((await call(f, refresh, { rawBody: "x".repeat(65537) })).status).toBe(413);
    expect(f.calls).toEqual([]);
  });
  it("does not follow redirects or return oversized upstream bodies", async () => {
    for (const reply of [{ status: 302, body: Buffer.from('{"location":"https://elsewhere.invalid"}') }, { status: 200, body: Buffer.alloc(65537) }]) {
      const f = await fixture(async () => reply); expect((await call(f)).status).toBe(502);
    }
  });
  it("sanitizes native rejection descriptions and bounds per-attempt refresh rate", async () => {
    const f = await fixture(async () => ({ status: 400, body: Buffer.from('{"error":"invalid_grant","error_description":"synthetic-sensitive-detail"}') }));
    for (let i = 0; i < 6; i++) expect((await call(f)).body).toEqual({ error: "invalid_grant", error_description: "Claude OAuth refresh was rejected." });
    expect((await call(f)).status).toBe(429);
  });
  it("checks active attempt ownership again before delivering refreshed credentials", async () => {
    const f = await fixture(async () => { f.scope.active = false; return { status: 200, body: Buffer.from(JSON.stringify(success)) }; });
    expect((await call(f)).status).toBe(409);
    expect(f.calls).toEqual([]);
  });
  it("caps simultaneous forwards and cancels outstanding requests when the socket closes", async () => {
    let entered = 0; const aborted: AbortSignal[] = [];
    const f = await fixture(async (_body, signal) => { entered++; aborted.push(signal); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); });
    const pending = Array.from({ length: 4 }, () => call(f).catch(() => null));
    while (entered < 4) await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await call(f)).status).toBe(429); await f.relay.close(); await Promise.all(pending);
    expect(aborted.every((signal) => signal.aborted)).toBe(true);
  });
});
