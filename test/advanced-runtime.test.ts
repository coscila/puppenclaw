import { createServer, request, type Server, type RequestListener } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AdvancedRuntime } from "../src/advanced/runtime.js";
import { UsageParser } from "../src/advanced/usage.js";
import { AdvancedStore } from "../src/advanced/store.js";
import { publicAddress } from "../src/advanced/egress.js";
import { startParamsZod } from "../src/shared/schema.js";
import { TurnStatisticsStore } from "../src/statistics/store.js";
import { TurnStatisticsRecorder } from "../src/statistics/recorder.js";
import type { SessionInfo } from "../src/shared/types.js";
import type { UsageReceipt, WorkerJob } from "../src/advanced/types.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); delete process.env.TEST_MODEL_KEY; });
const root = () => mkdtemp(join(tmpdir(), "advanced-runtime-"));
async function upstream(handler: RequestListener): Promise<{ url: string; server: Server }> {
  const server = createServer(handler); await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address");
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  return { server, url: `http://127.0.0.1:${address.port}/v1` };
}
async function setup(baseUrl: string, mode: "plan" | "execute" = "execute") {
  const runtime = await AdvancedRuntime.open(await root()); cleanups.push(() => runtime.close()); process.env.TEST_MODEL_KEY = "test-secret";
  const params = startParamsZod.parse({ name: "main", agent: "codex", directory: "/tmp", task: "review", interactionMode: mode, permissionMode: mode === "execute" ? "approve-all" : "approve-reads", statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt" }, modelProvider: { id: "local", model: "test-model", kind: "codex-openai-compatible", baseUrl, authTokenEnv: "TEST_MODEL_KEY" }, orchestration: { version: 1, revision: 1, workers: [{ id: "refs", assignment: "Check sources", agent: "codex", modelProvider: { id: "local", model: "test-model", kind: "codex-openai-compatible", baseUrl, authTokenEnv: "TEST_MODEL_KEY" } }] } });
  const session = { ...params, state: "idle", warnings: [], transcript: [], createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() } as SessionInfo;
  runtime.attach({ start: async () => ({ content: [{ type: "text", text: "done" }], details: { output: "done", session: { state: "completed" } } }), quiesce: async () => {}, getSession: () => session, contribution: () => {} });
  await runtime.begin(session, params, params.permissionMode!);
  return { runtime, socket: runtime.socket("main")!, params, session };
}
function unix(socketPath: string, path: string, value?: unknown, headers: Record<string,string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => { const req = request({ socketPath, path, method: value === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers } }, (res) => { let text = ""; res.once("aborted", () => reject(new Error("Response aborted"))); res.once("error", reject); res.on("data", (chunk) => { text += chunk; }); res.once("end", () => { let body: unknown; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: res.statusCode!, body }); }); }); req.once("error", reject); req.end(value === undefined ? undefined : JSON.stringify(value)); });
}
async function settled(socket: string, id: string) { for (let i = 0; i < 200; i++) { const result = await unix(socket, `/jobs/${id}`); if (!["queued", "running"].includes(result.body.state)) return result.body; await new Promise((done) => setTimeout(done, 5)); } throw new Error("Job did not settle"); }

describe("advanced usage", () => {
  it("parses rechunked SSE and cumulative cache usage without double counting; incomplete EOF remains partial", () => {
    const parser = new UsageParser(true);
    const stream = 'data: {"type":"message_start","message":{"model":"claude","usage":{"input_tokens":10,"cache_read_input_tokens":30,"cache_creation_input_tokens":20,"output_tokens":1}}}\r\n\r\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\ndata: {"type":"message_stop"}\n\n';
    for (const letter of stream) parser.feed(letter); parser.finish(true);
    expect(parser.usage).toMatchObject({ input: 60, output: 5, cacheRead: 30, cacheWrite: 20, total: 65, quality: "measured" });
    const incomplete = new UsageParser(false); incomplete.feed('data: {"usage":{"input_tokens":15,"output_tokens":4,"input_tokens_details":{"cached_tokens":5}}}\n\n'); incomplete.finish(true);
    expect(incomplete.usage).toMatchObject({ input: 15, cacheRead: 5, output: 4, total: 19, quality: "partial" });
  });
  it("replaces receipts before aggregating main, child and bulk models, ignoring repeated SDK totals", async () => {
    const store = await TurnStatisticsStore.open(await root()); const recorder = new TurnStatisticsRecorder(store, { listComputeJobs: () => [] }); cleanups.push(() => recorder.close());
    recorder.admit({ version: 1, chatId: "chat", attemptId: "attempt" }, { name: "main", agent: "codex" }, "turn");
    const receipt = (id: string, role: "main" | "subagent", providerId: string, input: number): UsageReceipt => ({ version: 1, requestId: id, parentSessionName: "main", sessionName: role === "main" ? "main" : "worker", attemptId: "attempt", providerId, model: providerId, role, promptSha256: "abc", state: "completed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), usage: { input, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: input + 5, quality: "measured" } });
    recorder.observeBrokerUsage("main", [receipt("one", "main", "anthropic", 10)]);
    recorder.observeBrokerUsage("main", [receipt("one", "main", "anthropic", 10), receipt("two", "subagent", "local", 20), receipt("three", "subagent", "langdock", 30)]);
    recorder.observeEvent("main", { type: "turn.completed", usage: { input_tokens: 100000, output_tokens: 50000 } }, "codex"); await recorder.settle("main", "completed");
    expect(store.page().turns[0]!.tokens).toMatchObject({ input: 60, output: 15, total: 75 });
    expect(store.page().turns[0]!.models?.map((m) => m.modelProviderId)).toEqual(["anthropic", "local", "langdock"]);
  });
});

describe("scoped worker broker", () => {
  it("keeps the trusted short socket root under literal /tmp when daemon TMPDIR changes", async () => {
    const custom = await root(), previous = process.env.TMPDIR; process.env.TMPDIR = custom;
    try { const { socket } = await setup("http://127.0.0.1:1/v1"); expect(socket).toMatch(/^\/tmp\/ocsl-model-broker-[0-9]+-[a-f0-9]{12}\/[a-f0-9]{24}\.sock$/); }
    finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
  });
  it("runs idempotent structured bulk once, keeps caller IDs and blocks unconfigured native models", async () => {
    let calls = 0; const { url } = await upstream((req, res) => { expect(req.headers.authorization).toBe("Bearer test-secret"); calls++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: "test-model", output_text: '{"verdict":true}', usage: { input_tokens: 12, output_tokens: 3 } })); });
    const { runtime, socket } = await setup(url);
    const data = { configId: "refs", idempotencyKey: "batch", concurrency: 2, items: [{ id: "citation-1", input: "check it" }, { id: "citation-2", input: { messages: [{ role: "user", content: "check this" }] } }], schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { verdict: { type: "boolean" } }, required: ["verdict"], additionalProperties: false } };
    const first = (await unix(socket, "/bulk/submit", data)).body; expect((await unix(socket, "/bulk/submit", data)).body.jobId).toBe(first.jobId);
    const result = await settled(socket, first.jobId); expect(result.state).toBe("completed"); expect(result.results.map((r: any) => r.id)).toEqual(["citation-1", "citation-2"]); expect(result.results[0].output).toEqual({ verdict: true }); expect(calls).toBe(2);
    expect((await unix(socket, "/bulk/submit", { ...data, items: [{ id: "different", input: "change" }] })).status).toBe(409);
    expect((await unix(socket, "/native/v1/responses", { model: "unconfigured" })).status).toBe(409); expect(calls).toBe(2); expect(runtime.store.receipts("main")).toHaveLength(2);
  });
  it("pauses on quota, preserves completed items and explicitly resumes only missing work", async () => {
    let calls = 0, failing = true; const { url } = await upstream((_req, res) => { calls++; res.setHeader("content-type", "application/json"); if (calls === 2 && failing) { res.statusCode = 429; res.end('{"error":"quota"}'); } else res.end('{"model":"test-model","output_text":"ok","usage":{"input_tokens":10,"output_tokens":2}}'); });
    const { runtime, socket } = await setup(url); const data = { configId: "refs", idempotencyKey: "quota", concurrency: 1, items: [1, 2, 3].map((i) => ({ id: `${i}`, input: `work${i}` })) };
    const job = (await unix(socket, "/bulk/submit", data)).body; const paused = await settled(socket, job.jobId); expect(paused.state).toBe("paused"); expect(calls).toBe(2); expect(paused.results[0].state).toBe("completed"); failing = false;
    const resumed = (await unix(socket, `/jobs/${job.jobId}/resume`, {})).body; const result = await settled(socket, resumed.jobId); expect(result.results.map((r: any) => r.id)).toEqual(["2", "3"]); expect(result.state).toBe("completed"); expect(calls).toBe(4); expect(runtime.store.receipts("main")).toHaveLength(4);
  });
  it("keeps planning permissions and waits for cancellation receipts before closing a turn", async () => {
    let entered!: () => void; const started = new Promise<void>((done) => { entered = done; }); const { url } = await upstream((_req, res) => { entered(); res.setHeader("content-type", "text/event-stream"); res.write('data: {"response":{"model":"test-model","usage":{"input_tokens":10,"output_tokens":1}}}\n\n'); });
    const plan = await setup(url, "plan"); expect((await unix(plan.socket, "/bulk/submit", { configId: "refs", idempotencyKey: "denied", items: [{ id: "x", input: "x" }] })).status).toBe(409);
    const { runtime, socket } = await setup(url); const call = unix(socket, "/native/v1/responses", { model: "test-model", input: "x", stream: true }).catch(() => null); await started; for (let i = 0; i < 100 && runtime.store.receipts("main")[0]?.usage.input === null; i++) await new Promise((done) => setTimeout(done, 5)); expect(runtime.store.receipts("main")[0]!.usage).toMatchObject({ input: 10, output: 1, quality: "partial" }); await runtime.closeTurn("main"); await call;
    const receipt = runtime.store.receipts("main")[0]!; expect(receipt.state).toBe("cancelled"); expect(receipt.usage.quality).not.toBe("measured"); expect((await unix(socket, "/configs")).status).toBe(409);
  });
  it("closes established main connections before the parent turn barrier resolves", async () => {
    const { runtime, socket } = await setup("http://127.0.0.1:1/v1"); const client = connect(socket); client.on("error", () => client.destroy()); await new Promise<void>((done) => client.once("connect", done));
    const received = new Promise<void>((done) => client.once("data", () => done())); client.write("GET /configs HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n"); await received;
    const closed = new Promise<void>((done) => client.once("close", () => done())); await runtime.closeTurn("main"); await closed; expect(client.destroyed).toBe(true);
  });
  it("forwards managed Codex OAuth on its native endpoint without replacing auth", async () => {
    const { url } = await upstream((req, res) => { expect(req.url).toBe("/backend-api/codex/responses"); expect(req.headers.authorization).toBe("Bearer oauth-fixture"); res.setHeader("content-type", "application/json"); res.end('{"model":"test-model","output_text":"ok","usage":{"input_tokens":10,"output_tokens":2}}'); });
    const { runtime, socket, params, session } = await setup(url); await runtime.closeTurn("main"); const provider = { ...params.modelProvider!, kind: "codex-openai" as const }; await runtime.begin({ ...session, modelProvider: provider }, { ...params, modelProvider: provider, statisticsContext: { version: 1, chatId: "chat", attemptId: "oauth" } }, "approve-all");
    const response = await unix(socket, "/native/backend-api/codex/responses", { model: "test-model", input: "hello" }, { authorization: "Bearer oauth-fixture" }); expect(response.status).toBe(200); expect(runtime.store.receipts("main", "oauth")[0]).toMatchObject({ providerId: "local", model: "test-model", usage: { input: 10, output: 2, total: 12 } });
  });
  it("records safe native authentication failures without retaining response bodies or credential values", async () => {
    const { url } = await upstream((req, res) => { expect(req.headers.authorization).toBeUndefined(); res.statusCode = 401; res.setHeader("content-type", "application/json"); res.end('{"error":{"type":"authentication_error","message":"secret diagnostic body"}}'); });
    const { runtime, socket, params, session } = await setup(url); await runtime.closeTurn("main"); const provider = { ...params.modelProvider!, kind: "claude-code" as const }; await runtime.begin({ ...session, modelProvider: provider }, { ...params, modelProvider: provider, statisticsContext: { version: 1, chatId: "chat", attemptId: "auth" } }, "approve-all");
    expect((await unix(socket, "/native/v1/messages", { model: "test-model", messages: [] })).status).toBe(401);
    const receipt = runtime.store.receipts("main", "auth")[0]!; expect(receipt).toMatchObject({ state: "failed", httpStatus: 401, errorCode: "authentication_error", authTransport: "missing" }); expect(JSON.stringify(receipt)).not.toContain("secret diagnostic body");
  });
  it("records transport error codes separately from upstream HTTP rejection", async () => {
    const { server, url } = await upstream(() => {}); await new Promise<void>((done) => server.close(() => done()));
    const { runtime, socket } = await setup(url); expect((await unix(socket, "/native/v1/responses", { model: "test-model", input: "x" })).status).toBe(400);
    expect(runtime.store.receipts("main")[0]).toMatchObject({ state: "failed", errorCode: "ECONNREFUSED", authTransport: "authorization" }); expect(runtime.store.receipts("main")[0]!.httpStatus).toBeUndefined();
  });
  it("pins native agent workers to parent planning permissions and records actual calls", async () => {
    const { url } = await upstream((_req, res) => { res.setHeader("content-type", "application/json"); res.end('{"model":"actual-test-model","output_text":"ok","usage":{"input_tokens":10,"output_tokens":2}}'); });
    const { runtime, socket, session } = await setup(url, "plan"); let captured: any; const quiesced: string[] = [];
    runtime.attach({ start: async (params) => { captured = params; expect(runtime.environment(params.name).PUPPENCLAW_ORCHESTRATION_JOB_ID).toBeDefined(); await unix(runtime.socket(params.name)!, "/native/v1/responses", { model: "test-model", input: params.task }); return { content: [{ type: "text", text: "done" }], details: { output: "done", session: { state: "completed" } } }; }, quiesce: async (name) => { quiesced.push(name); }, getSession: () => session, contribution: () => {} });
    const job = (await unix(socket, "/agent/submit", { configId: "refs", idempotencyKey: "agent", task: "Review a reference" })).body; const result = await settled(socket, job.jobId);
    expect(captured).toMatchObject({ directory: session.directory, permissionMode: "approve-reads", interactionMode: "plan" }); expect(captured.task).toContain("Check sources"); expect(result).toMatchObject({ parentSessionName: "main", config: { id: "refs", modelProvider: { id: "local", model: "test-model" } } });
    expect(result.results[0]).toMatchObject({ model: "actual-test-model", usage: { input: 10, output: 2, total: 12 }, receiptDigests: [{ model: "actual-test-model" }] }); expect(result.results[0].promptSha256).toHaveLength(64); expect(quiesced).toEqual([captured.name]); expect(runtime.store.receipts("main")[0]!.role).toBe("subagent");
  });
  it("cascades parent cancellation before returning and permanently purges confidential artifacts", async () => {
    const { url } = await upstream((_req, res) => { res.setHeader("content-type", "application/json"); res.end('{"output_text":"secret-result","usage":{"input_tokens":4,"output_tokens":2}}'); });
    const { runtime, socket, session } = await setup(url); let entered!: () => void, finish!: () => void;
    const started = new Promise<void>((done) => { entered = done; }); const held = new Promise<void>((done) => { finish = done; }); const quiesced: string[] = [];
    runtime.attach({ start: async () => { entered(); await held; return { content: [{ type: "text", text: "secret" }], details: {} }; }, quiesce: async (name) => { quiesced.push(name); finish(); }, getSession: () => session, contribution: () => {} });
    const agent = (await unix(socket, "/agent/submit", { configId: "refs", idempotencyKey: "held", task: "secret-task" })).body; await started; await runtime.closeTurn("main"); expect(runtime.store.job(agent.jobId)!.state).toBe("cancelled"); expect(quiesced).toHaveLength(1);
    await runtime.purge("main"); expect(runtime.jobs("main")).toEqual([]); expect(runtime.store.receipts("main")).toEqual([]); expect(runtime.socket("main")).toBeUndefined();
  });
  it("rejects old child sockets after a new parent attempt starts", async () => {
    const { url } = await upstream((_req, res) => res.end('{}')); const { runtime, socket, params, session } = await setup(url); let child!: string;
    runtime.attach({ start: async (p) => { child = p.name; return { content: [{ type: "text", text: "done" }], details: {} }; }, quiesce: async () => {}, getSession: () => session, contribution: () => {} });
    const job = (await unix(socket, "/agent/submit", { configId: "refs", idempotencyKey: "old", task: "old" })).body; await settled(socket, job.jobId); const oldSocket = runtime.socket(child)!; await runtime.closeTurn("main"); await runtime.begin(session, { ...params, statisticsContext: { version: 1, chatId: "chat", attemptId: "new" } }, "approve-all"); expect((await unix(oldSocket, "/configs")).status).toBe(409);
  });
  it("recovers ambiguous jobs without automatic redispatch and keeps completed item results", async () => {
    const dir = await root(); let store = await AdvancedStore.open(dir); const now = new Date().toISOString(); const job: WorkerJob = { jobId: "job", kind: "bulk", state: "running", parentSessionName: "main", attemptId: "attempt", configRevision: 1, config: { id: "refs", assignment: "sources", agent: "codex", modelProvider: { id: "local", model: "test", kind: "codex-openai-compatible" } }, idempotencyKey: "key", fingerprint: "fingerprint", createdAt: now, updatedAt: now, request: { configId: "refs", idempotencyKey: "key", items: [{ id: "one", input: "x" }, { id: "two", input: "y" }], concurrency: 1 }, results: ["completed", "running"].map((state, i) => ({ id: ["one", "two"][i]!, state: state as "completed" | "running", providerId: "local", model: "test", promptSha256: "hash", usage: null })) };
    store.putJob(job); store.close(); store = await AdvancedStore.open(dir); expect(store.recover()).toEqual([]); expect(store.job("job")!.state).toBe("interrupted"); expect(store.job("job")!.results.map((r) => r.state)).toEqual(["completed", "interrupted"]); expect(store.duplicate("main", "attempt", "key")!.jobId).toBe("job"); store.close();
  });
  it("rejects private, numeric transition and multicast egress addresses", () => { for (const address of ["127.0.0.1", "10.2.3.4", "169.254.169.254", "::1", "::ffff:c0a8:1", "2002:c0a8:0101::", "fc00::1", "ff02::1"]) expect(publicAddress(address)).toBe(false); expect(publicAddress("8.8.8.8")).toBe(true); expect(publicAddress("2606:4700::1111")).toBe(true); });
});
