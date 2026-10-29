import { createServer, request, type RequestListener, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";

import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdvancedRuntime } from "../src/advanced/runtime.js";
import { BulkResponseTransport } from "../src/advanced/bulk-transport.js";
import type { BulkConcurrencyOptions } from "../src/advanced/concurrency.js";
import { instrumentSystemPrompt, type InstrumentBundle } from "../src/advanced/instruments.js";
import type { BrokerJobPayload, BrokerReceiptPayload } from "../src/advanced/outbox.js";
import { startParamsZod } from "../src/shared/schema.js";
import type { SessionInfo } from "../src/shared/types.js";
import type { UsageReceipt } from "../src/advanced/types.js";
import { TurnStatisticsRecorder } from "../src/statistics/recorder.js";
import { TurnStatisticsStore } from "../src/statistics/store.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); delete process.env.TEST_MODEL_KEY; });

type Upstream = { url: string; server: Server; sockets: Set<Socket>; requests: { path: string; body: Record<string, unknown>; headers: Record<string, unknown> }[] };
async function upstream(handler: (body: Record<string, unknown>, res: Parameters<RequestListener>[1], index: number) => void | Promise<void>): Promise<Upstream> {
  const requests: Upstream["requests"] = [], sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
    requests.push({ path: req.url ?? "", body, headers: req.headers });
    await handler(body, res, requests.length);
  });
  server.on("connection", (socket) => { sockets.add(socket); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address");
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  return { server, sockets, requests, url: `http://127.0.0.1:${address.port}/v1` };
}
const reply = (res: Parameters<RequestListener>[1], payload: unknown, status = 200, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(payload));
};
const answer = (text: string, extra: Record<string, unknown> = {}) => ({ model: "served-model", status: "completed", output_text: text, usage: { input_tokens: 12, output_tokens: 3 }, ...extra });

async function setup(baseUrl: string, options: { concurrency?: BulkConcurrencyOptions; direct?: Map<string, string>; attempts?: number; timeoutMs?: number; backoffMs?: number } = {}) {
  const transport = new BulkResponseTransport(options.timeoutMs ?? 60_000, options.direct ?? new Map());
  const runtime = await AdvancedRuntime.open(await mkdtemp(join(tmpdir(), "advanced-p2-")), options.concurrency, { transport, retry: { attempts: options.attempts ?? 3, baseDelayMs: options.backoffMs ?? 1, maxDelayMs: Math.max(5, options.backoffMs ?? 1) } });
  cleanups.push(() => runtime.close()); process.env.TEST_MODEL_KEY = "test-secret";
  const provider = { id: "local", model: "test-model", kind: "codex-openai-compatible" as const, baseUrl, authTokenEnv: "TEST_MODEL_KEY" };
  const params = startParamsZod.parse({ name: "main", agent: "codex", directory: "/tmp", task: "review", interactionMode: "execute", permissionMode: "approve-all", statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt" }, modelProvider: provider, orchestration: { version: 1, revision: 1, workers: [{ id: "refs", assignment: "Check sources", agent: "codex", modelProvider: provider }] } });
  const session = { ...params, state: "idle", warnings: [], transcript: [], createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() } as SessionInfo;
  runtime.attach({ start: async () => ({ content: [{ type: "text", text: "done" }], details: { output: "done", session: { state: "completed" } } }), quiesce: async () => {}, getSession: () => session, contribution: () => {} });
  await runtime.begin(session, params, "approve-all");
  return { runtime, socket: runtime.socket("main")! };
}
function unix(socketPath: string, path: string, value?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => { const req = request({ socketPath, path, agent: false, method: value === undefined ? "GET" : "POST", headers: { "content-type": "application/json" } }, (res) => { let text = ""; res.on("data", (chunk) => { text += chunk; }); res.once("end", () => { let body: unknown; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: res.statusCode!, body }); }); }); req.once("error", reject); req.end(value === undefined ? undefined : JSON.stringify(value)); });
}
async function settled(socket: string, id: string) { for (let i = 0; i < 400; i++) { const result = await unix(socket, `/jobs/${id}`); if (!["queued", "running"].includes(result.body.state)) return result.body; await new Promise((done) => setTimeout(done, 5)); } throw new Error("Job did not settle"); }

const bundle = (overrides: Partial<InstrumentBundle> = {}): InstrumentBundle => ({
  instrumentId: "citation-census@1", version: 1, systemPrompt: "Judge each entry. Emit one JSON line per entry.", responseSchema: null,
  maxOutputTokens: { perItem: 700, minimum: 3000 }, temperature: 0, seed: null, reasoning: "none", itemsPerCall: 40, requiredModelFingerprint: null, ...overrides
});
const DIGEST = "e12996191d4e4ad18fe7f21921ff7a3b3f98889031dc5975fff31074c17b9a52";

describe("P2 instrument mode", () => {
  it("takes the system prompt, output budget, sampling and schema from the installed bundle and sends the messages verbatim", async () => {
    const up = await upstream((_body, res) => reply(res, answer('{"labels":["T"]}')));
    const { runtime, socket } = await setup(up.url);
    const schema = { type: "object", properties: { labels: { type: "array", items: { type: "string" }, uniqueItems: true } }, required: ["labels"] };
    const installed = runtime.installInstrument(DIGEST, bundle({ responseSchema: schema, seed: 4242 }));
    expect(installed.settingsSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect((await unix(socket, "/configs")).body).toMatchObject({ instrumentMode: 1, instruments: [{ digest: DIGEST, instrumentId: "citation-census@1", version: 1, itemsPerCall: 40 }] });
    const messages = [{ role: "user", content: "ENTRY 1\nENTRY 2" }];
    const job = (await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "census", instrumentDigest: DIGEST, items: [{ id: "batch-1", input: { messages, itemCount: 2 } }, { id: "batch-2", input: { messages, itemCount: 40 } }, { id: "batch-3", input: "ONE ENTRY" }] })).body;
    const done = await settled(socket, job.jobId);
    expect(done.state).toBe("completed");
    expect(up.requests).toHaveLength(3);
    for (const { body } of up.requests) {
      const input = body.input as { role: string; content: unknown }[];
      // System prompt = the broker's worker policy, a blank line, then the instrument prompt.
      expect(input[0]).toEqual({ role: "system", content: instrumentSystemPrompt(String(input[0]!.content).split("\n\n")[0]!, bundle()) });
      expect(String(input[0]!.content).startsWith("You are a scientific worker")).toBe(true);
      expect(body).toMatchObject({ model: "test-model", stream: false, temperature: 0, seed: 4242, reasoning: { effort: "none" } });
      // The provider gets the dialect-safe schema; validation stays local.
      expect((body.text as { format: { schema: unknown } }).format.schema).toEqual(schema);
    }
    const budgets = up.requests.map((entry) => entry.body.max_output_tokens).sort((a, b) => Number(a) - Number(b));
    expect(budgets).toEqual([3000, 3000, 28_000]);
    expect(up.requests.find((entry) => entry.body.max_output_tokens === 28_000)!.body.input).toEqual([expect.anything(), ...messages]);
    expect(up.requests.some((entry) => JSON.stringify(entry.body.input).includes("ONE ENTRY") && (entry.body.input as unknown[]).length === 2)).toBe(true);
    const receipts = runtime.store.jobReceipts(job.jobId);
    expect(receipts).toHaveLength(3);
    expect(new Set(receipts.map((row) => row.instrumentDigest))).toEqual(new Set([DIGEST]));
  });

  it("refuses a bulk job naming an instrument that is not installed, and per-item settings in instrument mode", async () => {
    const up = await upstream((_body, res) => reply(res, answer("ok")));
    const { runtime, socket } = await setup(up.url);
    const refused = await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "unknown", instrumentDigest: "not-installed", items: [{ id: "x", input: "x" }] });
    expect(refused).toMatchObject({ status: 400, body: { code: "INSTRUMENT_NOT_ALLOWED" } });
    runtime.installInstrument(DIGEST, bundle());
    expect((await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "schema", instrumentDigest: DIGEST, schema: { type: "object" }, items: [{ id: "x", input: "x" }] })))
      .toMatchObject({ status: 400, body: { code: "INSTRUMENT_REQUEST_CONFLICT" } });
    const job = (await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "override", instrumentDigest: DIGEST, items: [{ id: "x", input: { messages: [{ role: "user", content: "x" }], temperature: 1 } }, { id: "y", input: { messages: [{ role: "system", content: "override" }] } }, { id: "z", input: { messages: [{ role: "user", content: "x" }], itemCount: 41 } }] })).body;
    const done = await settled(socket, job.jobId);
    expect(done.results.map((result: { state: string; errorCode: string }) => [result.state, result.errorCode])).toEqual([["failed", "INVALID_REQUEST"], ["failed", "INVALID_REQUEST"], ["failed", "INVALID_REQUEST"]]);
    expect(up.requests).toHaveLength(0);
    expect(() => runtime.installInstrument(DIGEST, bundle({ temperature: 0.5 }))).toThrow(expect.objectContaining({ code: "INSTRUMENT_DIGEST_CONFLICT" }));
    expect(runtime.installInstrument(DIGEST, bundle()).digest).toBe(DIGEST);
  });

  it("runs an instrument whose response schema has an $id in every job, next to another schema under the same $id, compiling each schema once", async () => {
    const up = await upstream((_body, res) => reply(res, answer('{"label":"T"}')));
    const { runtime, socket } = await setup(up.url);
    const schema = (extra: Record<string, unknown>) => ({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: "https://example.org/schemas/label.schema.json", type: "object", properties: { label: { type: "string" } }, required: ["label"], ...extra });
    runtime.installInstrument(DIGEST, bundle({ responseSchema: schema({}) }));
    runtime.installInstrument("second", bundle({ responseSchema: schema({ additionalProperties: false }) }));
    const compile = vi.spyOn(Ajv2020.prototype, "compile");
    try {
      for (const [index, digest] of [DIGEST, DIGEST, "second", "second", DIGEST].entries()) {
        const job = (await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: `schema-id-${index}`, instrumentDigest: digest, items: [{ id: "a", input: "x" }] })).body;
        const done = await settled(socket, job.jobId);
        expect(done.state).toBe("completed");
        expect(done.results[0].output).toEqual({ label: "T" });
      }
      // Installing compiled both schemas; the five jobs reused them.
      expect(compile).not.toHaveBeenCalled();
    } finally { compile.mockRestore(); }
  });

  it("marks finish_reason=length truncated, keeps a text output and fails a cut structured output", async () => {
    const incomplete = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    const up = await upstream((body, res) => reply(res, answer(body.text ? '{"labels":["T"' : "T\nF\n", incomplete)));
    const { runtime, socket } = await setup(up.url);
    runtime.installInstrument(DIGEST, bundle());
    runtime.installInstrument("structured", bundle({ responseSchema: { type: "object" } }));
    const text = (await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "text", instrumentDigest: DIGEST, items: [{ id: "a", input: "x" }] })).body;
    const structured = (await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "structured", instrumentDigest: "structured", items: [{ id: "b", input: "x" }] })).body;
    expect((await settled(socket, text.jobId)).results[0]).toMatchObject({ state: "completed", truncated: true, finishReason: "length", output: "T\nF\n" });
    expect((await settled(socket, structured.jobId)).results[0]).toMatchObject({ state: "failed", truncated: true, errorCode: "STRUCTURED_OUTPUT_INVALID" });
    const receiptsByJob = new Map(runtime.store.events(0, 100).events.filter((event) => event.type === "broker.receipt").map((event) => [event.jobId, event.payload as BrokerReceiptPayload]));
    expect(receiptsByJob.get(text.jobId)).toMatchObject({ status: "truncated", finishReason: "length", error: null, output: "T\nF\n", instrumentDigest: DIGEST });
    expect(receiptsByJob.get(structured.jobId)).toMatchObject({ status: "truncated", error: { code: "STRUCTURED_OUTPUT_INVALID", retryable: false } });
    const jobs = runtime.store.events(0, 100).events.filter((event) => event.type === "broker.job").map((event) => event.payload as BrokerJobPayload);
    expect(jobs.find((payload) => payload.jobId === text.jobId && payload.state === "completed")!.counts).toMatchObject({ total: 1, succeeded: 0, truncated: 1 });
  });

  it("pauses the job on model drift when the instrument requires a fingerprint", async () => {
    const up = await upstream((_body, res) => reply(res, answer("T", { system_fingerprint: "fp_other" })));
    const { runtime, socket } = await setup(up.url);
    runtime.installInstrument(DIGEST, bundle({ requiredModelFingerprint: "nvidia/Qwen3.8-Flash-Next-NVFP4" }));
    const job = (await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "drift", instrumentDigest: DIGEST, concurrency: 1, items: [{ id: "a", input: "x" }, { id: "b", input: "y" }] })).body;
    const done = await settled(socket, job.jobId);
    expect(done.state).toBe("paused");
    expect(done.results[0]).toMatchObject({ state: "paused", errorCode: "MODEL_DRIFT" }); expect(done.results[0]).not.toHaveProperty("output");
    expect(up.requests).toHaveLength(1);
  });

  it("pauses on model drift before parsing, so a drifted answer that is not JSON, fails the schema or was cut still stops the job", async () => {
    const incomplete = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    const schema = { type: "object", properties: { labels: { type: "array" } }, required: ["labels"], additionalProperties: false };
    for (const drifted of [answer("not json at all", { model: "other-model" }), answer('{"unexpected":true}', { model: "other-model" }), answer('{"labels":["T"', { model: "other-model", ...incomplete })]) {
      const up = await upstream((_body, res) => reply(res, drifted));
      const { runtime, socket } = await setup(up.url);
      runtime.installInstrument(DIGEST, bundle({ responseSchema: schema, requiredModelFingerprint: "nvidia/Qwen3.8-Flash-Next-NVFP4" }));
      const job = (await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "drift", instrumentDigest: DIGEST, concurrency: 1, items: [{ id: "a", input: "x" }, { id: "b", input: "y" }] })).body;
      const done = await settled(socket, job.jobId);
      expect(done.state).toBe("paused");
      expect(done.results[0]).toMatchObject({ state: "paused", errorCode: "MODEL_DRIFT", model: "other-model" });
      expect(done.results[0]).not.toHaveProperty("output");
      expect(done.results[1].state).toBe("queued");
      // One call: the drift paused the provider before the second item.
      expect(up.requests).toHaveLength(1);
      const receipts = runtime.store.events(0, 100).events.filter((event) => event.type === "broker.receipt").map((event) => event.payload as BrokerReceiptPayload);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ itemId: "a", status: "failed", error: { code: "MODEL_DRIFT" }, model: "other-model" });
      expect(receipts[0]).not.toHaveProperty("output");
    }
  });
});

describe("P2 receipts, retries and the pooled upstream", () => {
  it("gives every receipt a non-empty serverFingerprint and settingsSha256: bulk, retried, native and agent", async () => {
    let calls = 0;
    const up = await upstream((_body, res) => { calls += 1; if (calls === 2) reply(res, { error: { type: "bad_gateway" } }, 502); else reply(res, answer("ok", calls === 1 ? { system_fingerprint: "fp_qwen" } : {}), 200, { server: "uvicorn" }); });
    const { runtime, socket } = await setup(up.url);
    const bulk = (await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "fp", concurrency: 1, items: [{ id: "a", input: "x" }, { id: "b", input: "y" }] })).body;
    await settled(socket, bulk.jobId);
    expect((await unix(socket, "/native/v1/responses", { model: "test-model", input: "native", stream: false })).status).toBe(200);
    const agent = (await unix(socket, "/agent/submit", { configId: "refs", idempotencyKey: "agent", task: "Review" })).body;
    await settled(socket, agent.jobId);
    const receipts = runtime.store.receipts("main");
    expect(receipts.length).toBeGreaterThanOrEqual(4);
    expect(receipts.every((row) => typeof row.serverFingerprint === "string" && row.serverFingerprint.length > 0 && /^[0-9a-f]{64}$/u.test(row.settingsSha256 ?? ""))).toBe(true);
    expect(receipts.find((row) => row.itemId === "a")!.serverFingerprint).toBe("fp_qwen");
    expect(receipts.find((row) => row.itemId === "b" && row.state === "completed")!.serverFingerprint).toMatch(/^served-model@[0-9a-f]{16}$/u);
    const events = runtime.store.events(0, 100).events.filter((event) => event.type === "broker.receipt").map((event) => event.payload as BrokerReceiptPayload);
    expect(events.map((payload) => payload.jobId === agent.jobId ? "agent" : payload.itemId).sort()).toEqual(["a", "agent", "b"]);
    expect(events.every((payload) => payload.serverFingerprint.length > 0 && /^[0-9a-f]{64}$/u.test(payload.settingsSha256))).toBe(true);
  });

  it("retries 502, 503, connection resets and timeouts with backoff, records each attempt and settles once", async () => {
    const plan = ["502", "reset", "503", "ok", "hang", "ok"]; let index = 0;
    const up = await upstream((_body, res) => {
      const step = plan[index++] ?? "ok";
      if (step === "502" || step === "503") reply(res, { error: { type: "unavailable" } }, Number(step));
      else if (step === "reset") res.socket?.destroy();
      else if (step === "hang") return;
      else reply(res, answer("ok"));
    });
    const { runtime, socket } = await setup(up.url, { attempts: 4, timeoutMs: 200 });
    const first = (await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "retry", concurrency: 1, items: [{ id: "a", input: "x" }] })).body;
    expect((await settled(socket, first.jobId)).results[0]).toMatchObject({ state: "completed", attempts: 4, output: "ok" });
    const receipts = runtime.store.jobReceipts(first.jobId);
    expect(receipts.map((row) => [row.attempt, row.state, row.httpStatus ?? row.errorCode])).toEqual([[1, "failed", 502], [2, "failed", expect.stringMatching(/ECONNRESET|UND_ERR_SOCKET|transport_error/u)], [3, "failed", 503], [4, "completed", 200]]);
    const second = (await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "timeout", concurrency: 1, items: [{ id: "b", input: "y" }] })).body;
    expect((await settled(socket, second.jobId)).results[0]).toMatchObject({ state: "completed", attempts: 2 });
    expect(runtime.store.jobReceipts(second.jobId).map((row) => row.errorCode ?? "ok")).toEqual(["BULK_RESPONSE_TIMEOUT", "ok"]);
    const events = runtime.store.events(0, 100).events.filter((event) => event.type === "broker.receipt").map((event) => event.payload as BrokerReceiptPayload);
    expect(events.map((payload) => [payload.itemId, payload.attempt, payload.status])).toEqual([["a", 4, "succeeded"], ["b", 2, "succeeded"]]);
  });

  it("settles an item cancelled during its retry backoff as cancelled, with the receipt of its last attempt", async () => {
    let calls = 0;
    const up = await upstream((_body, res) => { calls += 1; reply(res, { error: { type: "bad_gateway" } }, 502); });
    const { runtime, socket } = await setup(up.url, { attempts: 3, backoffMs: 10_000 });
    const job = (await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "backoff", concurrency: 1, items: [{ id: "a", input: "x" }, { id: "b", input: "y" }] })).body;
    for (let i = 0; i < 200 && calls === 0; i++) await new Promise((done) => setTimeout(done, 5));
    await new Promise((done) => setTimeout(done, 20));
    const started = Date.now();
    const cancelled = (await unix(socket, `/jobs/${job.jobId}/cancel`, {})).body;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.results.map((result: { state: string; errorCode: string; attempts?: number }) => [result.state, result.errorCode, result.attempts ?? null])).toEqual([["cancelled", "CANCELLED", 1], ["cancelled", "CANCELLED", null]]);
    expect(calls).toBe(1);
    const events = runtime.store.events(0, 100).events.filter((event) => event.type === "broker.receipt").map((event) => event.payload as BrokerReceiptPayload);
    expect(events.map((payload) => [payload.itemId, payload.status, payload.attempt])).toEqual([["a", "cancelled", 1]]);
  });

  it("settles an item whose retry is refused before dispatch with the receipt of its last call", async () => {
    const up = await upstream((body, res) => {
      if (JSON.stringify(body.input).includes("LIMITED")) reply(res, { error: { type: "rate_limit_error" } }, 429);
      else reply(res, { error: { type: "bad_gateway" } }, 502);
    });
    const { runtime, socket } = await setup(up.url, { attempts: 3, backoffMs: 300 });
    const job = (await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "refused-retry", concurrency: 2, items: [{ id: "a", input: "FLAKY" }, { id: "b", input: "LIMITED" }] })).body;
    let done: any;
    for (let i = 0; i < 400; i++) {
      done = (await unix(socket, `/jobs/${job.jobId}`)).body;
      if (done.results.every((result: { state: string }) => !["queued", "running"].includes(result.state))) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(done.state).toBe("paused");
    // b's 429 paused the provider while a waited to retry its 502; a's retry was refused before dispatch.
    expect(done.results.map((result: { id: string; state: string; errorCode: string; attempts?: number }) => [result.id, result.state, result.errorCode, result.attempts ?? null]))
      .toEqual([["a", "paused", "PROVIDER_PAUSED", 1], ["b", "paused", "PROVIDER_RATE_LIMITED", 1]]);
    expect(done.results[0].settingsSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(done.results[0].serverFingerprint).toBeTruthy();
    expect(up.requests).toHaveLength(2);
    const events = runtime.store.events(0, 100).events.filter((event) => event.type === "broker.receipt").map((event) => event.payload as BrokerReceiptPayload);
    expect(events.map((payload) => [payload.itemId, payload.attempt, payload.status, payload.error?.code]).sort())
      .toEqual([["a", 1, "failed", "PROVIDER_PAUSED"], ["b", 1, "failed", "PROVIDER_RATE_LIMITED"]]);
  });

  it("never retries a rate limit: the provider pauses at once with resumeAfter, and a lasting 503 pauses after the last attempt", async () => {
    const up = await upstream((body, res) => {
      if (JSON.stringify(body.input).includes("limited")) reply(res, { error: { type: "rate_limit_error" } }, 429, { "retry-after": "120" });
      else reply(res, { error: { type: "overloaded" } }, 503, { "x-ratelimit-reset-requests": "30s" });
    });
    const limited = await setup(up.url, { attempts: 3 });
    const before = Date.now();
    const job = (await unix(limited.socket, "/bulk/submit", { configId: "refs", idempotencyKey: "limited", concurrency: 1, items: [{ id: "a", input: "limited" }, { id: "b", input: "limited" }] })).body;
    const paused = await settled(limited.socket, job.jobId);
    expect(paused).toMatchObject({ state: "paused", results: [{ state: "paused", errorCode: "PROVIDER_RATE_LIMITED" }, { state: "queued" }] });
    expect(Date.parse(paused.resumeAfter) - before).toBeGreaterThanOrEqual(119_000);
    expect((await unix(limited.socket, `/jobs/${job.jobId}?view=summary`)).body.resumeAfter).toBe(paused.resumeAfter);
    expect(up.requests).toHaveLength(1);
    const overloaded = await setup(up.url, { attempts: 3 });
    const other = (await unix(overloaded.socket, "/bulk/submit", { configId: "refs", idempotencyKey: "overloaded", concurrency: 1, items: [{ id: "c", input: "busy" }] })).body;
    expect(await settled(overloaded.socket, other.jobId)).toMatchObject({ state: "paused", results: [{ state: "paused", attempts: 3, errorCode: "PROVIDER_UNREACHABLE" }] });
    expect(up.requests).toHaveLength(4);
    expect(overloaded.runtime.store.jobHeader(other.jobId)!.resumeAfter).toBeDefined();
  });

  it("sends tool-free bulk calls straight to the mapped upstream over a keep-alive pool sized to the group limit", async () => {
    const direct = await upstream((_body, res) => { setTimeout(() => reply(res, answer("direct")), 2); });
    const proxy = await upstream((_body, res) => reply(res, answer("proxy")));
    const { runtime, socket } = await setup(proxy.url, { concurrency: { defaultLimit: 4 }, direct: new Map([[proxy.url, direct.url]]) });
    const job = (await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "pooled", concurrency: 8, items: Array.from({ length: 60 }, (_, index) => ({ id: `i${index}`, input: `entry ${index}` })) })).body;
    const done = await settled(socket, job.jobId);
    expect(done.state).toBe("completed");
    expect(direct.requests).toHaveLength(60);
    expect(direct.sockets.size).toBeLessThanOrEqual(4);
    expect(direct.requests.every((entry) => entry.path === "/v1/responses" && entry.headers.authorization === "Bearer test-secret")).toBe(true);
    // Agents (native calls) still use the registered endpoint, i.e. the namespace proxy.
    expect((await unix(socket, "/native/v1/responses", { model: "test-model", input: "native" })).body.output_text).toBe("proxy");
    expect(proxy.requests).toHaveLength(1);
    expect(runtime.store.jobReceipts(job.jobId).every((row) => row.state === "completed")).toBe(true);
  });
});

describe("P2 receipt hooks", () => {
  it("delivers bulk receipt updates in batches, newest state per call, and flushes them before the parent turn closes", async () => {
    const up = await upstream((_body, res) => reply(res, answer("ok")));
    const { runtime, socket } = await setup(up.url);
    const batches: UsageReceipt[][] = [], single: UsageReceipt[] = [];
    const session = { name: "main" } as SessionInfo;
    runtime.attach({ start: async () => ({ content: [], details: {} }), quiesce: async () => {}, getSession: () => session, contribution: (receipt) => single.push(receipt), contributions: (receipts) => batches.push(receipts) });
    const job = (await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "batched", concurrency: 4, items: Array.from({ length: 20 }, (_, index) => ({ id: `i${index}`, input: `x${index}` })) })).body;
    await settled(socket, job.jobId);
    expect((await unix(socket, "/native/v1/responses", { model: "test-model", input: "native" })).status).toBe(200);
    await runtime.closeTurn("main");
    const delivered = batches.flat();
    // Every bulk call arrives once in its final state; the native call keeps the per-receipt path.
    expect(new Set(delivered.map((receipt) => receipt.requestId)).size).toBe(20);
    expect(delivered.filter((receipt) => receipt.state === "completed")).toHaveLength(20);
    expect(batches.length).toBeLessThan(20);
    expect(single.every((receipt) => receipt.itemId === undefined)).toBe(true);
    expect(single.length).toBeGreaterThan(0);
  });

  it("checkpoints statistics once per receipt batch", async () => {
    const store = await TurnStatisticsStore.open(await mkdtemp(join(tmpdir(), "advanced-p2-stats-")));
    const recorder = new TurnStatisticsRecorder(store, { listComputeJobs: () => [] }); cleanups.push(() => recorder.close());
    recorder.admit({ version: 1, chatId: "chat", attemptId: "attempt" }, { name: "main", agent: "codex" }, "turn");
    const receipt = (id: string): UsageReceipt => ({ version: 1, requestId: id, parentSessionName: "main", sessionName: "main", attemptId: "attempt", jobId: "job", itemId: id, providerId: "local", model: "m", role: "subagent", promptSha256: "p", state: "completed", createdAt: "now", updatedAt: "now", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 12, quality: "measured" } });
    const before = Number(store.page().turns[0]!.revision);
    recorder.observeBrokerReceipts("main", Array.from({ length: 50 }, (_, index) => receipt(`r${index}`)));
    recorder.observeBrokerReceipts("main", [{ ...receipt("other-attempt"), attemptId: "another" }]);
    const row = store.page().turns[0]!;
    expect(Number(row.revision) - before).toBe(1);
    expect(row.tokens).toMatchObject({ input: 500, output: 100, total: 600 });
  });
});
