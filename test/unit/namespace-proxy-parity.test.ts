import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";

import { Agent, fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { shapeLikeNamespaceProxy } from "../../src/advanced/bulk-transport.js";

/**
 * Differential check of the direct bulk route against the namespace proxy it
 * bypasses: the same payloads go through the real proxy and through
 * shapeLikeNamespaceProxy, and the upstream must receive identical requests.
 * Opt-in, because the proxy lives in the lab repository:
 *   PUPPENCLAW_NAMESPACE_PROXY_SCRIPT=/path/to/qwen38-namespace-proxy.py npx vitest run test/unit/namespace-proxy-parity.test.ts
 */
const script = process.env.PUPPENCLAW_NAMESPACE_PROXY_SCRIPT;
const received: { body: unknown; headers: IncomingHttpHeaders; url: string | undefined }[] = [];
let upstream: Server, proxy: ChildProcess, upstreamPort = 0, proxyPort = 0;
const dispatcher = new Agent();

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createNetServer(); probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(typeof address === "object" && address ? address.port : 0)); });
  });
}

describe.skipIf(!script)("direct bulk calls reach the upstream exactly as through the namespace proxy", () => {
  beforeAll(async () => {
    upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      received.push({ body: raw ? JSON.parse(raw) : null, headers: req.headers, url: req.url });
      res.setHeader("content-type", "application/json"); res.end('{"model":"chat","output_text":"ok"}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamPort = (upstream.address() as { port: number }).port;
    proxyPort = await freePort();
    proxy = spawn("python3", [script!, "--listen-port", String(proxyPort), "--upstream-host", "127.0.0.1", "--upstream-port", String(upstreamPort)], { stdio: "ignore" });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await fetch(`http://127.0.0.1:${proxyPort}/_codex_qwen_proxy_v7_health`).then((response) => response.ok, () => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("namespace proxy did not start");
  }, 20_000);
  afterAll(async () => { proxy?.kill(); upstream?.close(); await dispatcher.destroy(); });

  const policy = "You are a scientific worker for this approved parent turn.";
  const cases: Record<string, unknown>[] = [
    { model: "chat", input: [{ role: "system", content: policy }, { role: "user", content: JSON.stringify({ assignment: "a", messages: [{ role: "user", content: "OCSL_STATUS_NO_TOOLS" }] }) }], stream: false, temperature: 0, reasoning: { effort: "none" } },
    { model: "chat", input: [{ role: "system", content: `${policy}\n\nINSTRUMENT` }, { role: "user", content: "OCSL_STATUS_NO_TOOLS\nentries" }], stream: false, max_output_tokens: 3000, temperature: 0, seed: 7, reasoning: { effort: "none" }, text: { format: { type: "json_schema", name: "worker_result", strict: true, schema: { type: "object" } } } },
    { model: "chat", input: [{ role: "user", content: [{ type: "input_text", text: "OCSL_INITIAL_PLAN_NO_TOOLS" }] }, { role: "assistant", content: "a" }, { role: "user", content: "OCSL_PLAN_FEEDBACK_TURN_NO_TOOLS\nb" }], stream: false },
    { model: "chat", input: [{ role: "user", content: "OCSL_EXECUTION_TURN_TOOLS_ALLOWED\nc" }], stream: false },
    { model: "chat", input: [{ role: "developer", content: "OCSL_TRUSTED_TURN_POLICY_PLAN_NO_TOOLS" }, { role: "user", content: "d" }], stream: false },
    { model: "chat", instructions: "OCSL_TRUSTED_TURN_POLICY_PLAN_NO_TOOLS\nx", input: [{ role: "user", content: "e" }], stream: false },
    { model: "chat", input: [{ type: "agent_message", author: "w", recipient: "m", content: [{ type: "input_text", text: "t" }, { type: "encrypted_content", encrypted_content: "enc" }] }, { type: "function_call", name: "f", arguments: "{\"a\":[1,{\"b\":2}" }], stream: false },
    { model: "chat", input: Array.from({ length: 7 }, (_, index) => ({ role: "user", content: [{ type: "input_text", text: `t${index}` }, { type: "input_image", image_url: `data:${index}` }] })), stream: false },
    { model: "chat", input: [{ role: "user", content: "ünïcödé ✓ tab\t" }], stream: false, temperature: 0.7, top_p: 0.95 }
  ];

  it.each(cases.map((payload, index) => [index, payload] as const))("case %i", async (_index, payload) => {
    const local = structuredClone(payload);
    shapeLikeNamespaceProxy(local);
    received.length = 0;
    const response = await undiciFetch(`http://127.0.0.1:${proxyPort}/v1/responses`, { method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json" }, body: JSON.stringify(payload), dispatcher });
    await response.text();
    expect(received[0]!.url).toBe("/v1/responses");
    expect(received[0]!.body).toEqual(local);
  });

  it("forwards the same headers, apart from keep-alive", async () => {
    received.length = 0;
    for (const port of [proxyPort, upstreamPort]) {
      await (await undiciFetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json" }, body: JSON.stringify(cases[0]), dispatcher })).text();
    }
    const comparable = (headers: IncomingHttpHeaders) => Object.fromEntries(Object.entries(headers).filter(([name]) => !["connection", "content-length"].includes(name)));
    expect(comparable(received[0]!.headers)).toEqual(comparable(received[1]!.headers));
  });
});
