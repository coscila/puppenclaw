import { createServer, request } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { BrokerJobPayload, BrokerReceiptPayload } from "../../src/advanced/outbox.js";
import { AdvancedRuntime } from "../../src/advanced/runtime.js";
import { AdvancedStore } from "../../src/advanced/store.js";
import type { UsageReceipt, WorkerJob } from "../../src/advanced/types.js";
import { persistedOrchestration } from "../../src/advanced/worker-policy.js";
import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { advancedOrchestrationZod, startParamsZod } from "../../src/shared/schema.js";
import type { ModelProviderConfig, SessionInfo } from "../../src/shared/types.js";
import { TurnStatisticsRecorder } from "../../src/statistics/recorder.js";
import { TurnStatisticsStore } from "../../src/statistics/store.js";
import { AdvancedStore as Store426d493 } from "../fixtures/legacy/advanced-store-426d493.js";
import { AdvancedStore as StoreCea4c29 } from "../fixtures/legacy/advanced-store-cea4c29.js";
import { SessionStore as SessionStore426d493 } from "../fixtures/legacy/session-store-426d493.js";
import { createStoreAndRouter, createTempDir, makeConfig } from "../helpers.js";

/**
 * Rollback safety of this version (brokerOutbox:2, worker policy, off-loop digests) against the daemon it replaces,
 * 426d493: nothing changed in any store schema. advanced.sqlite gains fields inside JSON only (job configs with worker
 * policy fields, item results and outbox payloads with resumedFromJobId and the upstream's answer), which 426d493's
 * store code opens, reads and writes. state.json never holds a worker policy field: a session persists only the
 * workers without one, in the frozen shape 426d493's session store loads. principals.sqlite is untouched.
 */
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); delete process.env.TEST_MODEL_KEY; });
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
const PIN = { id: "citation-census@1", digest: "a".repeat(64) };

async function upstream() {
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    calls += 1;
    if (calls === 2) { res.writeHead(429, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "rate_limited" } })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "judge-served", system_fingerprint: "fp_judge", status: "completed", output_text: "T", usage: { input_tokens: 9, output_tokens: 1 } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  return `http://127.0.0.1:${address.port}/v1`;
}

function unix(socketPath: string, path: string, value?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false, method: value === undefined ? "GET" : "POST", headers: { "content-type": "application/json" } }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; }); res.once("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.once("error", reject); req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}

async function settled(runtime: AdvancedRuntime, jobId: string) {
  for (let i = 0; i < 1000 && ["queued", "running"].includes(runtime.store.jobHeader(jobId)!.state); i++) await delay(5);
  await runtime.settled(jobId);
  return runtime.store.job(jobId)!;
}

const legacyJob = (jobId: string, overrides: Partial<WorkerJob> = {}): WorkerJob => ({
  jobId, kind: "bulk", state: "running", parentSessionName: "parent", attemptId: "attempt", configRevision: 1,
  config: { id: "judge", assignment: "Review", agent: "codex", modelProvider: { id: "judge", model: "judge-model", kind: "codex-openai-compatible" } },
  idempotencyKey: jobId, fingerprint: jobId, createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z",
  request: { configId: "judge", idempotencyKey: jobId, concurrency: 1, items: [{ id: "one", input: "x" }] },
  results: [{ id: "one", state: "queued", providerId: "judge", model: "judge-model", promptSha256: "p", usage: null }],
  ...overrides
});
const legacyReceipt = (jobId: string): UsageReceipt => ({
  version: 1, requestId: `${jobId}-request`, parentSessionName: "parent", sessionName: "parent", attemptId: "attempt", jobId, itemId: "one", providerId: "judge", model: "judge-served",
  role: "subagent", promptSha256: "a".repeat(64), state: "completed", httpStatus: 200, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 2, quality: "measured" },
  createdAt: "2026-10-30T00:00:01.000Z", updatedAt: "2026-10-30T00:00:02.000Z", attempt: 1, serverFingerprint: "fp", settingsSha256: "s".repeat(64)
});

describe("rollback to 426d493: advanced.sqlite", () => {
  it("lets 426d493's store code open, read and write a store with worker-policy jobs, resumed jobs and brokerOutbox:2 events", async () => {
    const baseUrl = await upstream();
    const dataDir = await mkdtemp(join("/tmp", "pcfr-"));
    const root = join(dataDir, "advanced");
    process.env.TEST_MODEL_KEY = "test-secret";
    const judge: ModelProviderConfig = { id: "remote_qwen38_none", model: "judge-model", kind: "codex-openai-compatible", baseUrl, authTokenEnv: "TEST_MODEL_KEY" };
    const runtime = await AdvancedRuntime.open(root, { defaultLimit: 4 }, { retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 5 } });
    runtime.useWorkerPolicy({ enabled: true, onPremises: new Map([[judge.id, judge]]) });
    const orchestration = advancedOrchestrationZod.parse({ version: 1, revision: 2, workers: [
      { id: "entitled", assignment: "Judge entitled full text", evidencePolicy: "entitled-institutional", capabilityProfile: "evidence-only", instruments: [PIN], agent: "codex", modelProvider: judge },
      { id: "plain", assignment: "Check sources", agent: "codex", modelProvider: judge }
    ] });
    const params = startParamsZod.parse({ name: "main", agent: "codex", directory: "/tmp", task: "review", interactionMode: "execute", permissionMode: "approve-all",
      statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt" }, modelProvider: judge, orchestration });
    const session = { ...params, orchestration: persistedOrchestration(orchestration), state: "idle", warnings: [], transcript: [], createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() } as unknown as SessionInfo;
    runtime.attach({ start: async () => ({ content: [], details: {} }), quiesce: async () => {}, getSession: () => session, contribution: () => {} });
    await runtime.begin(session, params, "approve-all");
    const socket = runtime.socket("main")!;
    runtime.installInstrument("b".repeat(64), { instrumentId: "citation-census@1", version: 1, systemPrompt: "Judge.\n", responseSchema: null, maxOutputTokens: { perItem: 700, minimum: 3000 }, temperature: 0, seed: null, reasoning: "none", itemsPerCall: 40, requiredModelFingerprint: null });
    const entitled = (await unix(socket, "/bulk/submit", { configId: "entitled", idempotencyKey: "entitled", instrumentDigest: "b".repeat(64), items: [{ id: "one", input: "entry" }] })).body;
    expect((await settled(runtime, entitled.jobId)).state).toBe("completed");
    // The second upstream call answers 429: the plain job pauses and a resume continues it as a new job.
    const paused = (await unix(socket, "/bulk/submit", { configId: "plain", idempotencyKey: "plain", items: [{ id: "one", input: "entry" }] })).body;
    expect((await settled(runtime, paused.jobId)).state).toBe("paused");
    const resumed = (await unix(socket, `/jobs/${paused.jobId}/resume`, {})).body;
    expect((await settled(runtime, resumed.jobId)).state).toBe("completed");
    const head = runtime.store.head();
    await runtime.close();

    const old = await Store426d493.open(root);
    expect(old.jobHeader(entitled.jobId)!.config).toMatchObject({ id: "entitled", evidencePolicy: "entitled-institutional", capabilityProfile: "evidence-only", instruments: [PIN] });
    expect(old.jobHeader(resumed.jobId)).toMatchObject({ state: "completed", resumedFromJobId: paused.jobId });
    const page = old.events(0, 1000);
    expect(page.head).toBe(head);
    const receipt = page.events.find((event) => event.type === "broker.receipt" && event.jobId === entitled.jobId)!.payload as unknown as BrokerReceiptPayload;
    expect(receipt).toMatchObject({ status: "succeeded", servedModel: "judge-served", systemFingerprint: "fp_judge", httpStatus: 200, serverFingerprint: "fp_judge" });
    expect((page.events.filter((event) => event.type === "broker.job" && event.jobId === resumed.jobId).map((event) => (event.payload as unknown as BrokerJobPayload).resumedFromJobId))).toContain(paused.jobId);
    expect(old.job(entitled.jobId)!.results[0]).toMatchObject({ state: "completed", servedModel: "judge-served", systemFingerprint: "fp_judge", httpStatus: 200 });
    expect(old.recover()).toEqual([]);
    // It keeps writing, with its own (brokerOutbox:1) payloads.
    old.createJob(legacyJob("legacy-job"));
    await old.settleItem("legacy-job", { id: "one", state: "completed", output: "T", providerId: "judge", model: "judge-served", promptSha256: "a".repeat(64), usage: legacyReceipt("legacy-job").usage }, { receipt: legacyReceipt("legacy-job"), event: true, persist: true, fallbackFingerprint: "fp", fallbackSettingsSha256: "s".repeat(64), instrumentDigest: null });
    const written = old.events(head, 100).events;
    expect(written.map((event) => [event.type, event.jobId])).toEqual([["broker.job", "legacy-job"], ["broker.receipt", "legacy-job"]]);
    expect(written[1]!.payload).not.toHaveProperty("servedModel");
    old.close();

    // Rolled forward, this version reads those events as written and adds no catch-up (426d493 kept the outbox itself).
    const again = await AdvancedStore.open(root);
    cleanups.push(() => again.close());
    expect(again.events(head, 100).events.map((event) => [event.seq, event.type, event.jobId])).toEqual(written.map((event) => [event.seq, event.type, event.jobId]));
    expect(again.job("legacy-job")!.results[0]).toMatchObject({ state: "completed" });
  });

  it("emits brokerOutbox:2 fields when it catches up on the jobs a daemon without an outbox changed", async () => {
    const dataDir = await createTempDir("pcfr-catchup-");
    const root = join(dataDir, "advanced");
    const fresh = await AdvancedStore.open(root);
    fresh.close();
    // The H4 daemon (no outbox) writes a resumed job and settles its item with a receipt that recorded an HTTP status.
    const h4 = await StoreCea4c29.open(root);
    h4.putJob({ ...legacyJob("resumed-job", { resumedFromJobId: "first-job" }) });
    h4.putReceipt(legacyReceipt("resumed-job"));
    h4.putJob({ ...legacyJob("resumed-job", { resumedFromJobId: "first-job", state: "completed" }), results: [{ id: "one", state: "completed", output: "T", providerId: "judge", model: "judge-served", promptSha256: "a".repeat(64), usage: legacyReceipt("resumed-job").usage }] });
    h4.close();
    const now = await AdvancedStore.open(root);
    cleanups.push(() => now.close());
    const events = now.events(0, 100).events;
    expect((events.find((event) => event.type === "broker.job")!.payload as BrokerJobPayload)).toMatchObject({ jobId: "resumed-job", state: "completed", resumedFromJobId: "first-job" });
    // The older daemon recorded no answer on the item: the fields are null, except the HTTP status its receipt kept.
    expect((events.find((event) => event.type === "broker.receipt")!.payload as BrokerReceiptPayload)).toMatchObject({ itemId: "one", servedModel: null, systemFingerprint: null, httpStatus: 200 });
  });
});

describe("rollback to 426d493: state.json", () => {
  it("never persists a worker policy field, so 426d493's session store loads the state of turns that carried them", async () => {
    const root = await createTempDir("pcfr-state-");
    const { store, outputRouter } = await createStoreAndRouter(join(root, "sessions"));
    const statistics = new TurnStatisticsRecorder(await TurnStatisticsStore.open(join(root, "statistics")), { listComputeJobs: () => [] });
    const advanced = await AdvancedRuntime.open(join(root, "advanced"));
    const command = fileURLToPath(new URL("../fixtures/fake-orchestrated-acpx.mjs", import.meta.url));
    const manager = new AcpxSessionManager({ config: makeConfig({ acpxCommand: `node ${command}` }), logger: { info() {}, warn() {}, error() {}, debug() {} }, store, outputRouter, advanced, statistics });
    advanced.attach({ start: (params) => manager.start(params), quiesce: async (name) => { await manager.quiesce({ name }); }, getSession: (name) => store.getSession(name), contribution: () => {} });
    let closed = false;
    const close = async () => { if (closed) return; closed = true; await advanced.close(); await statistics.close(); await store.close(); };
    cleanups.push(close);
    const claude: ModelProviderConfig = { id: "synthetic-claude", kind: "claude-code", model: "synthetic-model" };
    const judge: ModelProviderConfig = { id: "remote_qwen38_none", kind: "codex-openai-compatible", model: "judge-model", baseUrl: "http://127.0.0.1:9/v1", authTokenEnv: "TEST_MODEL_KEY" };
    const workers = [
      { id: "entitled", assignment: "Judge entitled full text", evidencePolicy: "entitled-institutional", capabilityProfile: "evidence-only", agent: "codex", modelProvider: judge },
      { id: "fixed", assignment: "Run the census instrument", capabilityProfile: "run-fixed-programs", instruments: [PIN], agent: "codex", modelProvider: judge },
      { id: "public", assignment: "Check public sources", evidencePolicy: "public-literature", agent: "claude", modelProvider: claude }
    ];
    const params = startParamsZod.parse({ name: "parent", agent: "claude", directory: root, task: "Seed existing session", permissionMode: "approve-all", interactionMode: "execute", modelProvider: claude, modelProviderId: claude.id,
      statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt-1" }, orchestration: { version: 1, revision: 3, workers } });
    expect((await manager.start(params)).details).toMatchObject({ output: "Seeded existing session." });
    expect(store.getSession("parent")!.orchestration).toEqual({ version: 1, revision: 3, workers: [workers[2]] });
    // A later turn whose workers all carry a policy leaves no orchestration in state, not the stale one of revision 3.
    const policyOnly = advancedOrchestrationZod.parse({ version: 1, revision: 4, workers: workers.slice(0, 2) });
    expect((await manager.send({ name: "parent", message: "Seed existing session again", permissionMode: "approve-all", interactionMode: "execute",
      statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt-2" }, orchestration: policyOnly, contextFiles: [] })).details).toMatchObject({ output: "Seeded existing session." });
    expect(store.getSession("parent")).not.toHaveProperty("orchestration");
    // A plain turn persists its orchestration again.
    expect((await manager.send({ name: "parent", message: "Seed existing session once more", permissionMode: "approve-all", interactionMode: "execute",
      statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt-3" }, orchestration: advancedOrchestrationZod.parse({ version: 1, revision: 5, workers: [workers[2]] }), contextFiles: [] })).details).toMatchObject({ output: "Seeded existing session." });
    expect(store.getSession("parent")!.orchestration).toEqual({ version: 1, revision: 5, workers: [workers[2]] });
    await close();
    const state = JSON.parse(await readFile(join(root, "sessions", "state.json"), "utf8")) as { sessions: Record<string, { orchestration?: unknown }> };
    expect(JSON.stringify(state)).not.toMatch(/capabilityProfile|instruments|entitled-institutional/u);

    const legacy = await SessionStore426d493.open(join(root, "sessions"));
    expect(legacy.getRecoveryStatus().required).toBe(false);
    expect(legacy.getSession("parent")).toMatchObject({ name: "parent", orchestration: { version: 1, revision: 5, workers: [{ id: "public", evidencePolicy: "public-literature" }] } });
    await legacy.close();

    // Control: had the session kept the turn's orchestration, 426d493 would have refused the whole state at load.
    const control = await createTempDir("pcfr-state-control-");
    state.sessions.parent!.orchestration = { version: 1, revision: 4, workers };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(control, "state.json"), JSON.stringify(state));
    const refused = await SessionStore426d493.open(control);
    expect(refused.getRecoveryStatus()).toMatchObject({ required: true });
    await refused.close();
  }, 20_000);
});
