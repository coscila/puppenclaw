import { createServer, request } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BrokerJobPayload, BrokerReceiptPayload } from "../../src/advanced/outbox.js";
import { AdvancedRuntime } from "../../src/advanced/runtime.js";
import { startParamsZod } from "../../src/shared/schema.js";
import type { ModelProviderConfig, SessionInfo } from "../../src/shared/types.js";

/**
 * brokerOutbox:2 payloads: broker.job carries resumedFromJobId (null when the job resumes none), broker.receipt the
 * upstream's own answer to the settling call (servedModel, systemFingerprint, httpStatus) next to model and
 * serverFingerprint, which can hold the requested model and the daemon's synthesized identity.
 */
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); delete process.env.TEST_MODEL_KEY; });
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Answer = { status: number; body: unknown };
async function upstream(answer: (input: string, call: number) => Answer) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    calls += 1;
    const payload = JSON.parse(body) as { input: { content: string }[] };
    const { status, body: reply } = answer(payload.input.at(-1)!.content, calls);
    res.writeHead(status, { "content-type": "application/json", server: "mock-vllm" }); res.end(JSON.stringify(reply));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  return { url: `http://127.0.0.1:${address.port}/v1`, calls: () => calls };
}

function unix(socketPath: string, path: string, value?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false, method: value === undefined ? "GET" : "POST", headers: { "content-type": "application/json" } }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; }); res.once("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.once("error", reject); req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}

async function turn(baseUrl: string) {
  process.env.TEST_MODEL_KEY = "test-secret";
  const runtime = await AdvancedRuntime.open(await mkdtemp(join("/tmp", "pcob-")), { defaultLimit: 4 }, { retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 5 } });
  cleanups.push(() => runtime.close());
  const provider: ModelProviderConfig = { id: "local", model: "judge-model", kind: "codex-openai-compatible", baseUrl, authTokenEnv: "TEST_MODEL_KEY" };
  const params = startParamsZod.parse({ name: "main", agent: "codex", directory: "/tmp", task: "review", interactionMode: "execute", permissionMode: "approve-all",
    statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt" }, modelProvider: provider,
    orchestration: { version: 1, revision: 1, workers: [{ id: "refs", assignment: "Check sources", agent: "codex", modelProvider: provider }] } });
  const session = { ...params, state: "idle", warnings: [], transcript: [], createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() } as unknown as SessionInfo;
  runtime.attach({ start: async () => ({ content: [], details: {} }), quiesce: async () => {}, getSession: () => session, contribution: () => {} });
  await runtime.begin(session, params, "approve-all");
  return { runtime, socket: runtime.socket("main")! };
}

async function settled(runtime: AdvancedRuntime, jobId: string) {
  for (let i = 0; i < 1000 && ["queued", "running"].includes(runtime.store.jobHeader(jobId)!.state); i++) await delay(5);
  await runtime.settled(jobId);
  return runtime.store.job(jobId)!;
}
const events = (runtime: AdvancedRuntime) => runtime.store.events(0, 1000).events;

describe("brokerOutbox:2 job events", () => {
  it("name the job a resumed job resumes, and null for every other job", async () => {
    const up = await upstream((_input, call) => call === 1
      ? { status: 429, body: { error: { code: "rate_limited" } } }
      : { status: 200, body: { model: "judge-served", status: "completed", output_text: "T", usage: { input_tokens: 9, output_tokens: 1 } } });
    const { runtime, socket } = await turn(up.url);
    const first = (await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "census", items: [{ id: "one", input: "entry one" }] })).body;
    expect((await settled(runtime, first.jobId)).state).toBe("paused");
    const resumed = (await unix(socket, `/jobs/${first.jobId}/resume`, {})).body;
    expect(resumed.resumedFromJobId).toBe(first.jobId);
    expect((await settled(runtime, resumed.jobId)).state).toBe("completed");
    await runtime.store.refreshJobCounts(resumed.jobId);
    const jobEvents = events(runtime).filter((event) => event.type === "broker.job").map((event) => event.payload as BrokerJobPayload);
    expect(jobEvents.filter((payload) => payload.jobId === first.jobId).map((payload) => payload.resumedFromJobId)).toEqual(jobEvents.filter((payload) => payload.jobId === first.jobId).map(() => null));
    const lineage = jobEvents.filter((payload) => payload.jobId === resumed.jobId);
    expect(lineage.length).toBeGreaterThan(0);
    expect(lineage.every((payload) => payload.resumedFromJobId === first.jobId)).toBe(true);
    expect(lineage.at(-1)).toMatchObject({ state: "completed", counts: { total: 1, succeeded: 1 } });
  });
});

describe("brokerOutbox:2 receipt events", () => {
  it("carry the served model, system_fingerprint and HTTP status of the settling call, null where the response named none", async () => {
    const up = await upstream((input) => {
      if (input.includes("named")) return { status: 200, body: { model: "judge-served", system_fingerprint: "fp_named", status: "completed", output_text: "T", usage: { input_tokens: 9, output_tokens: 1 } } };
      if (input.includes("anonymous")) return { status: 200, body: { status: "completed", output_text: "T", usage: { input_tokens: 9, output_tokens: 1 } } };
      return { status: 400, body: { error: { code: "context_length_exceeded" } } };
    });
    const { runtime, socket } = await turn(up.url);
    const job = (await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "answers", concurrency: 1, items: ["named", "anonymous", "refused"].map((id) => ({ id, input: `entry ${id}` })) })).body;
    const done = await settled(runtime, job.jobId);
    expect(done.results.map((result) => [result.id, result.state])).toEqual([["named", "completed"], ["anonymous", "completed"], ["refused", "failed"]]);
    const receipts = new Map(events(runtime).filter((event) => event.type === "broker.receipt").map((event) => [event.itemId, event.payload as BrokerReceiptPayload]));
    expect(receipts.get("named")).toMatchObject({ status: "succeeded", model: "judge-served", serverFingerprint: "fp_named", servedModel: "judge-served", systemFingerprint: "fp_named", httpStatus: 200 });
    // The response named no model and no fingerprint: model and serverFingerprint hold the requested model and the
    // daemon's synthesized identity, and the answer fields say what the upstream itself said: nothing.
    const anonymous = receipts.get("anonymous")!;
    expect(anonymous).toMatchObject({ status: "succeeded", model: "judge-model", servedModel: null, systemFingerprint: null, httpStatus: 200 });
    expect(anonymous.serverFingerprint).toMatch(/^judge-model@[0-9a-f]{16}$/u);
    expect(receipts.get("refused")).toMatchObject({ status: "failed", httpStatus: 400, servedModel: null, systemFingerprint: null });
    // The item results record the same answer.
    expect(done.results.find((result) => result.id === "anonymous")).toMatchObject({ servedModel: null, systemFingerprint: null, httpStatus: 200 });
  });
});
