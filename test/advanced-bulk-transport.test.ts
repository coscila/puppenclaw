import { createServer, type RequestListener } from "node:http";
import { Agent, fetch as legacyFetch } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { BulkResponseTransport, bulkResponseTimeout, DEFAULT_BULK_RESPONSE_TIMEOUT_MS } from "../src/advanced/bulk-transport.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function server(handler: RequestListener): Promise<URL> {
  const instance = createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("No listening address");
  cleanups.push(async () => { instance.closeAllConnections(); await new Promise<void>((resolve) => instance.close(() => resolve())); });
  return new URL(`http://127.0.0.1:${address.port}/v1/responses`);
}

function transport(timeoutMs: number): BulkResponseTransport {
  const result = new BulkResponseTransport(timeoutMs);
  cleanups.push(() => result.close());
  return result;
}

describe("bounded bulk response transport", () => {
  it("defaults to thirty minutes and rejects unbounded or malformed operator configuration", () => {
    expect(bulkResponseTimeout({})).toBe(DEFAULT_BULK_RESPONSE_TIMEOUT_MS);
    expect(bulkResponseTimeout({ PUPPENCLAW_BULK_RESPONSE_TIMEOUT_MS: "900000" })).toBe(900000);
    for (const value of ["", "0", "-1", "Infinity", "1.5", "86400001", "300junk"]) {
      expect(() => bulkResponseTimeout({ PUPPENCLAW_BULK_RESPONSE_TIMEOUT_MS: value })).toThrow("positive integer");
    }
  });

  it("receives delayed non-streaming headers beyond the former transport deadline", async () => {
    const url = await server((_req, res) => {
      // Scale the former five-minute deadline down, while exercising Undici's actual header timer.
      const timer = setTimeout(() => res.end('{"output_text":"complete"}'), 1600);
      res.once("close", () => clearTimeout(timer));
    });
    const oldDispatcher = new Agent({ headersTimeout: 100, bodyTimeout: 100 });
    cleanups.push(() => oldDispatcher.destroy());
    await expect(legacyFetch(url, { dispatcher: oldDispatcher })).rejects.toMatchObject({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
    const scope = transport(5000).start(new AbortController().signal);
    try {
      const response = await scope.fetch(url, {});
      expect(await response.json()).toEqual({ output_text: "complete" });
      expect(scope.timeoutError).toBeUndefined();
    } finally { scope.close(); }
  }, 10_000);

  it("bounds the entire body even when the server keeps sending bytes", async () => {
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => { closed = resolve; });
    const url = await server((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(" ");
      const timer = setInterval(() => res.write(" "), 10);
      res.once("close", () => { clearInterval(timer); closed(); });
    });
    const scope = transport(150).start(new AbortController().signal);
    try {
      const response = await scope.fetch(url, {});
      await expect(response.text()).rejects.toBeDefined();
      expect(scope.timeoutError).toMatchObject({ code: "BULK_RESPONSE_TIMEOUT" });
      await disconnected;
    } finally { scope.close(); }
  });

  it("cancels a delayed request immediately and closes the connection", async () => {
    let received!: () => void, closed!: () => void;
    const started = new Promise<void>((resolve) => { received = resolve; });
    const disconnected = new Promise<void>((resolve) => { closed = resolve; });
    const url = await server((_req, res) => { received(); res.once("close", closed); });
    const parent = new AbortController();
    const scope = transport(30_000).start(parent.signal);
    const pending = scope.fetch(url, {});
    const rejected = expect(pending).rejects.toBeDefined();
    await started;
    parent.abort();
    try {
      await rejected;
      await disconnected;
      expect(scope.timeoutError).toBeUndefined();
    } finally { scope.close(); }
  });

  it("clears its deadline after a consumed response", async () => {
    const url = await server((_req, res) => res.end("done"));
    const scope = transport(100).start(new AbortController().signal);
    expect(await (await scope.fetch(url, {})).text()).toBe("done");
    scope.close();
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(scope.signal.aborted).toBe(false);
  });
});
