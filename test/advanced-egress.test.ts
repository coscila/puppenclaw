import { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
const connectMock = vi.hoisted(() => vi.fn());
vi.mock("node:net", async () => ({ ...await vi.importActual<typeof import("node:net")>("node:net"), connect: connectMock }));
import { EgressPolicy, proxyConnect } from "../src/advanced/egress.js";
class Peer extends Duplex {
  failWrites = false;
  override _read(): void {}
  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void { callback(this.failWrites ? Object.assign(new Error("write EPIPE"), { code: "EPIPE" }) : null); }
}
const length = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
function hello(): Buffer {
  const name = Buffer.from("research.test"), entry = Buffer.concat([Buffer.from([0]), length(name.length), name]);
  const sni = Buffer.concat([length(entry.length), entry]); const extensions = Buffer.concat([length(0), length(sni.length), sni]);
  const data = Buffer.concat([Buffer.from([3,3]), Buffer.alloc(32), Buffer.from([0]), length(2), Buffer.from([0x13,1]), Buffer.from([1,0]), length(extensions.length), extensions]);
  const hs = Buffer.alloc(4); hs[0] = 1; hs.writeUIntBE(data.length, 1, 3); const record = Buffer.concat([hs, data]); return Buffer.concat([Buffer.from([22,3,1]), length(record.length), record]);
}
const policy = () => { const p = new EgressPolicy(); vi.spyOn(p, "destination").mockResolvedValue({ address: "8.8.8.8", family: 4, hostname: "research.test" }); return p; };
async function tunnel() { const remote = new Peer(); connectMock.mockImplementation(() => { queueMicrotask(() => remote.emit("connect")); return remote; }); const incoming = new Peer(); await proxyConnect(policy(), { url: "research.test:443" } as IncomingMessage, incoming, hello()); return { incoming, remote }; }
describe("CONNECT peer failure isolation", () => {
  it("retains permanent incoming and outbound error listeners after TLS inspection", async () => {
    const { incoming, remote } = await tunnel(); expect(incoming.listenerCount("error")).toBeGreaterThan(0); expect(remote.listenerCount("error")).toBeGreaterThan(0);
    expect(() => incoming.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow(); expect(incoming.destroyed).toBe(true); expect(remote.destroyed).toBe(true);
  });
  it("closes both peers when an upstream pipe write fails with EPIPE", async () => {
    const { incoming, remote } = await tunnel(); remote.failWrites = true; incoming.push(Buffer.from("late client bytes")); await new Promise((done) => setImmediate(done)); expect(remote.destroyed).toBe(true); expect(incoming.destroyed).toBe(true);
  });
  it("handles an early client closure without opening an upstream tunnel", async () => {
    connectMock.mockClear(); const incoming = new Peer(); const operation = proxyConnect(policy(), { url: "research.test:443" } as IncomingMessage, incoming, hello()); incoming.destroy(); await operation; expect(connectMock).not.toHaveBeenCalled();
  });
});
