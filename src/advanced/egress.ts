import { lookup, resolveCname } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { PuppenclawError } from "../shared/errors.js";

export function publicAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/gu, "");
  if (a.includes(":")) {
    return isIP(a) === 6 && /^[23][0-9a-f]{0,3}:/u.test(a) && !/^2001:(?:db8|0|2|10|20):|^2002:/u.test(a);
  }
  if (!isIP(a)) return false;
  const [first = 0, second = 0] = a.split(".").map(Number);
  return !(first === 0 || first === 10 || first === 127 || first >= 224 || first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 || first === 192 && [0, 168].includes(second) || first === 100 && second >= 64 && second <= 127 || first === 198 && [18, 19, 51].includes(second) || first === 203 && second === 0);
}
function hostName(host: string): string { return host.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, ""); }
/** Broker owns DNS and pins the address used by the socket; clients cannot select an alternate resolver/address. */
export class EgressPolicy {
  private readonly hosts = new Set(["api.anthropic.com", "api.openai.com", "chatgpt.com", "api.langdock.com"]);
  constructor(private readonly extraHosts: string[] = []) { for (const h of extraHosts) this.denyUrl(h); }
  denyUrl(raw: string): void { try { this.hosts.add(hostName(new URL(raw).hostname)); } catch { this.hosts.add(hostName(raw)); } }
  async destination(raw: string, port: number): Promise<{ address: string; family: number; hostname: string }> {
    const hostname = hostName(raw);
    if (![80, 443].includes(port) || isIP(hostname) || this.hosts.has(hostname) || /(^|\.)(localhost|local|internal)$/u.test(hostname)) throw new PuppenclawError("EGRESS_DENIED", "Use the metered broker for model endpoints; only public web destinations are allowed.");
    const aliases = new Set([hostname]); let cursor = hostname;
    for (let i = 0; i < 8; i++) {
      let names: string[] = []; try { names = await resolveCname(cursor); } catch { break; }
      if (!names.length) break;
      for (const name of names) { const h = hostName(name); if (this.hosts.has(h)) throw new PuppenclawError("EGRESS_DENIED", "Model endpoint aliases require the metered broker."); aliases.add(h); }
      cursor = hostName(names[0]!);
    }
    const addresses = await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address))) throw new PuppenclawError("EGRESS_DENIED", "Private or ambiguous web addresses are blocked.");
    const deniedAddresses = new Set<string>();
    for (const h of this.hosts) {
      if (isIP(h)) deniedAddresses.add(h);
      else try { for (const a of await lookup(h, { all: true })) deniedAddresses.add(a.address); } catch { /* An unavailable model host cannot open egress. */ }
    }
    if (addresses.some((a) => deniedAddresses.has(a.address))) throw new PuppenclawError("EGRESS_DENIED", "Model endpoint address aliases require the metered broker.");
    return { ...addresses[0]!, hostname };
  }
}
/** Read only the ClientHello. ECH and name/CONNECT mismatch cannot tunnel a configured endpoint through another authority. */
export function clientHelloServerName(data: Buffer): { ready: boolean; name?: string; encrypted?: boolean } {
  if (data.length < 5) return { ready: false };
  if (data[0] !== 22) throw new Error("HTTPS proxy requires a TLS ClientHello.");
  const length = data.readUInt16BE(3); if (data.length < length + 5) return { ready: false };
  if (data[5] !== 1) throw new Error("HTTPS proxy requires a TLS ClientHello.");
  let pos = 5 + 4 + 2 + 32;
  const need = (n: number) => { if (pos + n > data.length) throw new Error("Malformed ClientHello."); };
  need(1); const session = data[pos]!; pos += 1 + session; need(2); const ciphers = data.readUInt16BE(pos); pos += 2 + ciphers;
  need(1); const compression = data[pos]!; pos += 1 + compression; need(2); const extEnd = pos + 2 + data.readUInt16BE(pos); pos += 2;
  let name: string | undefined, encrypted = false;
  while (pos < extEnd) {
    need(4); const kind = data.readUInt16BE(pos), size = data.readUInt16BE(pos + 2); pos += 4; need(size);
    if (kind === 0xfe0d) encrypted = true;
    if (kind === 0 && size >= 5) { const n = data.readUInt16BE(pos + 3); if (data[pos + 2] !== 0 || n + 5 > size) throw new Error("Malformed TLS server name."); name = data.subarray(pos + 5, pos + 5 + n).toString("ascii").toLowerCase(); }
    pos += size;
  }
  return { ready: true, ...(name ? { name } : {}), encrypted };
}
export async function proxyConnect(policy: EgressPolicy, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  let upstream: Socket | undefined;
  // pipe() removes its internal error listener on failure; both peers need permanent guards.
  const failClosed = () => { socket.destroy(); upstream?.destroy(); };
  socket.on("error", failClosed); socket.once("close", () => upstream?.destroy());
  const target = new URL(`https://${req.url}`);
  const destination = await policy.destination(target.hostname, Number(target.port || 443));
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  let hello = head; const readHello = await new Promise<Buffer>((resolve, reject) => {
    const timeout = setTimeout(() => done(new Error("TLS handshake timed out.")), 15_000);
    let settled = false;
    const done = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timeout); socket.removeListener("data", onData); socket.removeListener("error", onError); socket.removeListener("close", onClose); error ? reject(error) : resolve(hello); };
    const check = () => { try { if (hello.length > 64 * 1024) return done(new Error("TLS ClientHello too large.")); const parsed = clientHelloServerName(hello); if (!parsed.ready) return; if (parsed.encrypted || parsed.name !== destination.hostname) return done(new Error("TLS authority mismatch or encrypted server name.")); socket.pause(); done(); } catch (e) { done(e as Error); } };
    const onData = (chunk: Buffer) => { hello = Buffer.concat([hello, chunk]); check(); }, onError = (error: Error) => done(error), onClose = () => done(new Error("Client disconnected."));
    socket.on("data", onData); socket.once("error", onError); socket.once("close", onClose); if (head.length) check();
  });
  if (socket.destroyed) return;
  const remote = connect({ host: destination.address, port: Number(target.port || 443), family: destination.family }); upstream = remote;
  remote.on("error", failClosed); remote.once("close", () => socket.destroy());
  await new Promise<void>((resolve, reject) => { remote.once("connect", resolve); remote.once("error", reject); remote.once("close", () => reject(new Error("Upstream closed during connection."))); });
  if (socket.destroyed || remote.destroyed) { failClosed(); return; }
  remote.write(readHello); socket.pipe(remote).pipe(socket); socket.resume();
}
export async function proxyHttp(policy: EgressPolicy, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const target = new URL(req.url!); if (target.protocol !== "http:") throw new Error("Use CONNECT for HTTPS.");
  if (req.headers.host?.toLowerCase() !== target.host.toLowerCase()) throw new Error("HTTP authority mismatch.");
  const destination = await policy.destination(target.hostname, Number(target.port || 80));
  const headers = { ...req.headers }; delete headers["proxy-authorization"]; delete headers["proxy-connection"];
  const upstream = httpRequest(target, { headers, method: req.method,
    lookup: (_name, _options, cb) => cb(null, destination.address, destination.family),
  }, (response) => { response.on("error", () => { upstream.destroy(); res.destroy(); }); if (res.destroyed) { response.destroy(); return; } res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
  upstream.on("error", () => { if (res.destroyed) return; if (!res.headersSent) res.writeHead(502); res.end(); });
  req.on("error", () => upstream.destroy()); res.on("error", () => upstream.destroy());
  res.once("close", () => upstream.destroy()); req.pipe(upstream);
}
