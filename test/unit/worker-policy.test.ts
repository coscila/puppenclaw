import { createServer, request, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AdvancedRuntime } from "../../src/advanced/runtime.js";
import type { InstrumentBundle } from "../../src/advanced/instruments.js";
import {
  CAPABILITY_PROFILE_DENIED,
  INSTRUMENT_NOT_PINNED,
  INSTRUMENT_REQUIRED,
  instrumentPinned,
  isOnPremisesProvider,
  onPremisesProvidersFromEnvironment,
  persistedOrchestration,
  PROVIDER_NOT_ON_PREMISES,
  sessionWithOrchestration,
  WORKER_POLICY_DISABLED,
  workerPolicyEnabledFromEnvironment
} from "../../src/advanced/worker-policy.js";
import { createDaemonServer } from "../../src/daemon/server.js";
import {
  advancedOrchestrationZod,
  INVALID_WORKER_POLICY,
  issueCode,
  persistedAdvancedOrchestrationZod,
  startParamsZod,
  UNSUPPORTED_CAPABILITY_PROFILE,
  UNSUPPORTED_EVIDENCE_POLICY
} from "../../src/shared/schema.js";
import type { AdvancedOrchestration, ModelProviderConfig, PersistedAdvancedOrchestration, SessionInfo } from "../../src/shared/types.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

/**
 * Worker policy (plan E4, capability advancedOrchestration.workerPolicy): the E4 worker fields coscila sends with
 * LAB_ORCHESTRATION_RECORD=v2 are accepted, refused when unknown, kept out of persisted session state, and enforced
 * where the daemon decides job admission.
 */
const cleanups: (() => Promise<void> | void)[] = [];
const ENV_KEYS = ["TEST_MODEL_KEY", "PUPPENCLAW_MODEL_PROVIDERS", "PUPPENCLAW_ONPREM_PROVIDERS", "PUPPENCLAW_WORKER_POLICY"] as const;
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); for (const key of ENV_KEYS) delete process.env[key]; });
const dataRoot = () => mkdtemp(join("/tmp", "pcwp-"));
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
const PIN = { id: "citation-census@1", digest: "a".repeat(64) };
const WRAPPED = "b".repeat(64);
const OTHER = "c".repeat(64);
const SYSTEM = "Judge each entry.\n";

const judgeProvider = (baseUrl: string, extra: Partial<ModelProviderConfig> = {}): ModelProviderConfig =>
  ({ id: "remote_qwen38_none", label: "Local LLM (no thinking)", model: "judge-model", kind: "codex-openai-compatible", baseUrl, authTokenEnv: "TEST_MODEL_KEY", reasoningProfile: "qwen-3.8", ...extra });
const claudeProvider: ModelProviderConfig = { id: "claude-subscription", label: "Claude", model: "claude-model", kind: "claude-code" };

/** The orchestration coscila f0a205d2's buildLabOrchestrationPayload sends a workerPolicy daemon for v2 worker configs. */
function v2Orchestration(baseUrl: string): AdvancedOrchestration {
  const judge = judgeProvider(baseUrl);
  return advancedOrchestrationZod.parse({
    version: 1, revision: 4, workers: [
      { id: "w1", assignment: "Judge entitled full text", evidencePolicy: "entitled-institutional", capabilityProfile: "evidence-only", agent: "codex", effort: "none", modelProvider: judge },
      { id: "w2", assignment: "Run the census instrument", capabilityProfile: "run-fixed-programs", instruments: [PIN], agent: "codex", effort: "none", modelProvider: judge },
      { id: "w3", assignment: "Run the workspace programs", capabilityProfile: "run-fixed-programs", agent: "codex", modelProvider: judge },
      { id: "w4", assignment: "Write the analysis code", capabilityProfile: "code-authoring", agent: "claude", modelProvider: claudeProvider },
      { id: "w5", assignment: "Run the workspace programs read-only", capabilityProfile: "run-fixed-programs", agent: "claude", modelProvider: claudeProvider },
      { id: "w6", assignment: "Check public sources", evidencePolicy: "public-literature", agent: "codex", effort: "none", modelProvider: judge },
      { id: "w7", assignment: "Summarise confidential drafts", evidencePolicy: "confidential-manuscript", capabilityProfile: "evidence-only", agent: "codex", modelProvider: judge },
      { id: "w8", assignment: "Plain worker", agent: "codex", modelProvider: judge }
    ]
  });
}

type Call = { path: string; body: string };
/** A Responses API fake; `hold` keeps every call open until release(). */
async function upstream(options: { hold?: boolean; answer?: (call: number, res: ServerResponse) => void } = {}) {
  const calls: Call[] = [], held: (() => void)[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    calls.push({ path: req.url ?? "", body });
    const answer = () => {
      if (options.answer) { options.answer(calls.length, res); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "judge-served", status: "completed", output_text: "T", usage: { input_tokens: 9, output_tokens: 1 } }));
    };
    if (options.hold) held.push(answer); else answer();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  return { url: `http://127.0.0.1:${address.port}/v1`, calls, release: () => { for (const answer of held.splice(0)) answer(); } };
}

function unix(socketPath: string, path: string, value?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false, method: value === undefined ? "GET" : "POST", headers: { "content-type": "application/json" } }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; }); res.once("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.once("error", reject); req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}

/** A chat turn of the v2 orchestration on a fresh runtime; `onPremises` declares the judge provider on premises. */
async function turn(options: { onPremises?: boolean; enabled?: boolean; hold?: boolean } = {}) {
  const up = await upstream(options.hold ? { hold: true } : {});
  process.env.TEST_MODEL_KEY = "test-secret";
  const runtime = await AdvancedRuntime.open(await dataRoot(), { defaultLimit: 4 }, { retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 5 } });
  cleanups.push(() => runtime.close());
  const judge = judgeProvider(up.url);
  runtime.useWorkerPolicy({ enabled: options.enabled ?? true, onPremises: options.onPremises ? new Map([[judge.id, judge]]) : new Map() });
  const started: string[] = [];
  const orchestration = v2Orchestration(up.url);
  const params = startParamsZod.parse({ name: "main", agent: "codex", directory: "/tmp", task: "review", interactionMode: "execute", permissionMode: "approve-all",
    statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt" }, modelProvider: judge, orchestration });
  const session = { ...sessionWithOrchestration(params as unknown as SessionInfo, params.orchestration), state: "idle", warnings: [], transcript: [], createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() } as SessionInfo;
  runtime.attach({ start: async (start) => { started.push(start.name); return { content: [{ type: "text", text: "done" }], details: { output: "done", session: { state: "completed" } } }; }, quiesce: async () => {}, getSession: () => session, contribution: () => {} });
  await runtime.begin(session, params, "approve-all");
  return { runtime, socket: runtime.socket("main")!, up, judge, started, params, session };
}

async function settled(runtime: AdvancedRuntime, jobId: string) {
  for (let i = 0; i < 1000 && ["queued", "running"].includes(runtime.store.jobHeader(jobId)!.state); i++) await delay(5);
  await runtime.settled(jobId);
  return runtime.store.job(jobId)!;
}

const bundle = (overrides: Partial<InstrumentBundle> = {}): InstrumentBundle => ({
  instrumentId: "citation-census@1", version: 1, systemPrompt: SYSTEM, responseSchema: null, maxOutputTokens: { perItem: 700, minimum: 3000 },
  temperature: 0, seed: null, reasoning: "none", itemsPerCall: 40, requiredModelFingerprint: null, ...overrides
});

describe("worker policy shapes", () => {
  it("accepts the E4 worker fields coscila sends for v2 worker configs and keeps legacy configurations as they were", () => {
    const parsed = v2Orchestration("http://127.0.0.1:18160/v1");
    expect(parsed.workers.map((worker) => [worker.id, worker.evidencePolicy ?? null, worker.capabilityProfile ?? null, worker.instruments?.map((pin) => pin.id) ?? null])).toEqual([
      ["w1", "entitled-institutional", "evidence-only", null], ["w2", null, "run-fixed-programs", ["citation-census@1"]], ["w3", null, "run-fixed-programs", null],
      ["w4", null, "code-authoring", null], ["w5", null, "run-fixed-programs", null], ["w6", "public-literature", null, null], ["w7", "confidential-manuscript", "evidence-only", null], ["w8", null, null, null]
    ]);
    const legacy = { version: 1, revision: 1, workers: [{ id: "refs", assignment: "Check sources", evidencePolicy: "public-literature", agent: "codex", modelProvider: judgeProvider("http://127.0.0.1:18160/v1") }] };
    expect(advancedOrchestrationZod.parse(legacy)).toEqual(legacy);
    expect(persistedAdvancedOrchestrationZod.parse(legacy)).toEqual(legacy);
  });

  it("refuses an unknown evidence policy or capability profile with a typed code, never ignoring it", () => {
    const base = v2Orchestration("http://127.0.0.1:18160/v1");
    const codes = (worker: Record<string, unknown>) => {
      const result = advancedOrchestrationZod.safeParse({ ...base, workers: [{ ...base.workers[7]!, ...worker }] });
      return result.success ? [] : result.error.issues.map((issue) => issueCode(issue) ?? issue.code);
    };
    expect(codes({ evidencePolicy: "tenant-confidential" })).toEqual([UNSUPPORTED_EVIDENCE_POLICY]);
    expect(codes({ evidencePolicy: "entitled-institutional-v2", capabilityProfile: "evidence-only" })).toEqual([UNSUPPORTED_EVIDENCE_POLICY]);
    expect(codes({ capabilityProfile: "network-free" })).toEqual([UNSUPPORTED_CAPABILITY_PROFILE]);
    // A value of the wrong type stays an ordinary invalid parameter.
    expect(codes({ evidencePolicy: 7 })).toEqual(["invalid_type"]);
    // The rules coscila's contract applies, checked again.
    expect(codes({ evidencePolicy: "entitled-institutional" })).toEqual([INVALID_WORKER_POLICY]);
    expect(codes({ evidencePolicy: "confidential-manuscript", capabilityProfile: "run-fixed-programs" })).toEqual([INVALID_WORKER_POLICY]);
    expect(codes({ instruments: [PIN] })).toEqual([INVALID_WORKER_POLICY]);
    expect(codes({ capabilityProfile: "evidence-only", instruments: [PIN, { ...PIN, digest: "d".repeat(64) }] })).toEqual([INVALID_WORKER_POLICY]);
    expect(codes({ capabilityProfile: "code-authoring" })).toEqual([INVALID_WORKER_POLICY]);
    expect(codes({ capabilityProfile: "evidence-only", instruments: [{ id: "census", digest: PIN.digest }] })).toEqual(["invalid_format"]);
    expect(codes({ capabilityProfile: "evidence-only", instruments: [] })).toEqual(["too_small"]);
    // A session never persists a worker policy field: its shape is the frozen one older daemons load.
    expect(persistedAdvancedOrchestrationZod.safeParse(base).success).toBe(false);
  });

  it("persists only workers without a policy, and drops a stale orchestration when none remains", () => {
    const config = v2Orchestration("http://127.0.0.1:18160/v1");
    const persisted = persistedOrchestration(config)!;
    expect(persisted.workers.map((worker) => worker.id)).toEqual(["w6", "w8"]);
    expect(persistedAdvancedOrchestrationZod.parse(persisted)).toEqual(persisted);
    expect(persisted.workers[0]).toEqual({ id: "w6", assignment: "Check public sources", evidencePolicy: "public-literature", agent: "codex", effort: "none", modelProvider: config.workers[5]!.modelProvider });
    const policyOnly = { ...config, workers: config.workers.slice(0, 2) };
    expect(persistedOrchestration(policyOnly)).toBeUndefined();
    type Session = { name: string; orchestration?: PersistedAdvancedOrchestration };
    const session: Session = { name: "main", orchestration: persisted }, bare: Session = { name: "main" };
    expect(sessionWithOrchestration(session, policyOnly)).toEqual({ name: "main" });
    expect(sessionWithOrchestration(session, undefined)).toBe(session);
    expect(sessionWithOrchestration(bare, config)).toEqual({ name: "main", orchestration: persisted });
  });
});

describe("on-premises provider configuration", () => {
  const configured = judgeProvider("http://127.0.0.1:18160/v1");
  const providers = new Map([[configured.id, configured], ["remote_langdock", { id: "remote_langdock", model: "gpt", kind: "codex-openai-compatible" as const, baseUrl: "http://127.0.0.1:18161/v1", authTokenEnv: "X" }], ["claude-subscription", claudeProvider]]);

  it("reads PUPPENCLAW_ONPREM_PROVIDERS against PUPPENCLAW_MODEL_PROVIDERS and refuses anything else at startup", () => {
    expect(onPremisesProvidersFromEnvironment({}, providers).size).toBe(0);
    expect([...onPremisesProvidersFromEnvironment({ PUPPENCLAW_ONPREM_PROVIDERS: JSON.stringify([configured.id]) }, providers).keys()]).toEqual([configured.id]);
    for (const [raw, message] of [
      ["remote_qwen38_none", /JSON array of provider ids/u], [JSON.stringify({ id: configured.id }), /JSON array of provider ids/u], [JSON.stringify(["bad id"]), /JSON array of provider ids/u],
      [JSON.stringify([configured.id, configured.id]), /twice/u], [JSON.stringify(["remote_unknown"]), /does not configure/u], [JSON.stringify(["claude-subscription"]), /no valid baseUrl/u]
    ] as const) expect(() => onPremisesProvidersFromEnvironment({ PUPPENCLAW_ONPREM_PROVIDERS: raw }, providers), raw).toThrow(message);
    expect(workerPolicyEnabledFromEnvironment({})).toBe(true);
    expect(workerPolicyEnabledFromEnvironment({ PUPPENCLAW_WORKER_POLICY: " OFF " })).toBe(false);
    expect(() => workerPolicyEnabledFromEnvironment({ PUPPENCLAW_WORKER_POLICY: "maybe" })).toThrow(/on or off/u);
  });

  it("decides on premises from the declared provider and its configured endpoint, never from the URL alone", () => {
    const onPremises = onPremisesProvidersFromEnvironment({ PUPPENCLAW_ONPREM_PROVIDERS: JSON.stringify([configured.id]) }, providers);
    // The same endpoint spelled with a trailing slash or without /v1, another model or credential variable: still on premises.
    for (const baseUrl of ["http://127.0.0.1:18160/v1", "http://127.0.0.1:18160/v1/", "http://127.0.0.1:18160"]) expect(isOnPremisesProvider(judgeProvider(baseUrl, { model: "other", authTokenEnv: "Y" }), onPremises), baseUrl).toBe(true);
    // The declared id at another endpoint, or another kind, is not.
    expect(isOnPremisesProvider(judgeProvider("http://127.0.0.1:18161/v1"), onPremises)).toBe(false);
    expect(isOnPremisesProvider(judgeProvider("https://api.example.org/v1"), onPremises)).toBe(false);
    expect(isOnPremisesProvider({ ...judgeProvider("http://127.0.0.1:18160/v1"), kind: "codex-openai" }, onPremises)).toBe(false);
    // A loopback endpoint whose id was not declared is not on premises: the lab's loopback proxies reach external services too.
    expect(isOnPremisesProvider({ id: "remote_langdock", model: "gpt", kind: "codex-openai-compatible", baseUrl: "http://127.0.0.1:18161/v1" }, onPremises)).toBe(false);
    expect(isOnPremisesProvider(judgeProvider("http://127.0.0.1:18160/v1", { id: "remote_qwen38_low" }), onPremises)).toBe(false);
  });

  it("matches pinned instruments by the installed bundle's id@version or an equal digest", () => {
    expect(instrumentPinned([PIN], { digest: WRAPPED, instrumentId: "citation-census@1", version: 1 })).toBe(true);
    expect(instrumentPinned([PIN], { digest: WRAPPED, instrumentId: "citation-census", version: 1 })).toBe(true);
    expect(instrumentPinned([PIN], { digest: PIN.digest, instrumentId: "renamed", version: 9 })).toBe(true);
    expect(instrumentPinned([PIN], { digest: WRAPPED, instrumentId: "citation-census@2", version: 2 })).toBe(false);
    expect(instrumentPinned([PIN], { digest: WRAPPED, instrumentId: "citation-census", version: 2 })).toBe(false);
  });
});

describe("worker policy on the turn socket", () => {
  it("lists each worker's policy and withholds bulk calls the policy forbids", async () => {
    const { socket } = await turn();
    const workers = new Map(((await unix(socket, "/configs")).body.workers as Record<string, unknown>[]).map((worker) => [worker.id, worker]));
    expect(workers.get("w1")).toMatchObject({ evidencePolicy: "entitled-institutional", capabilityProfile: "evidence-only", bulkAvailable: false });
    expect(workers.get("w2")).toMatchObject({ capabilityProfile: "run-fixed-programs", instruments: [PIN], bulkAvailable: true });
    expect(workers.get("w3")).toMatchObject({ capabilityProfile: "run-fixed-programs", bulkAvailable: false });
    expect(workers.get("w6")).toMatchObject({ evidencePolicy: "public-literature", bulkAvailable: true });
    // A worker without policy keeps exactly the fields it had (no effort set here), so strict readers of the catalog
    // (coscila-review's census pins its fields) see no change.
    expect(Object.keys(workers.get("w8")!).sort()).toEqual(["agent", "assignment", "bulkAvailable", "bulkConcurrencyLimit", "id", "model", "modelProvider", "providerId"]);
    const onPremises = await turn({ onPremises: true });
    const listed = ((await unix(onPremises.socket, "/configs")).body.workers as Record<string, unknown>[]).find((worker) => worker.id === "w1");
    expect(listed).toMatchObject({ evidencePolicy: "entitled-institutional", bulkAvailable: true });
  });

  it("refuses entitled and confidential evidence on a provider the daemon does not configure as on premises, before any call", async () => {
    const { runtime, socket, up } = await turn();
    for (const configId of ["w1", "w7"]) {
      const refused = await unix(socket, "/bulk/submit", { configId, idempotencyKey: `entitled-${configId}`, items: [{ id: "one", input: "Judge this full text." }] });
      expect(refused, configId).toMatchObject({ status: 403, body: { code: PROVIDER_NOT_ON_PREMISES } });
      expect(refused.body.error).toMatch(/on-premises providers only/u);
    }
    expect(runtime.store.jobHeaders("main")).toEqual([]);
    expect(up.calls).toHaveLength(0);
  });

  it("runs entitled evidence on the configured on-premises provider", async () => {
    const { runtime, socket, up } = await turn({ onPremises: true });
    const job = (await unix(socket, "/bulk/submit", { configId: "w1", idempotencyKey: "entitled", items: [{ id: "one", input: "Judge this full text." }] })).body;
    expect((await settled(runtime, job.jobId)).state).toBe("completed");
    expect(up.calls.map((call) => call.path)).toEqual(["/v1/responses"]);
    // The stored job keeps the worker's policy, so a resume under a changed policy is a changed configuration.
    expect(runtime.store.jobHeader(job.jobId)!.config).toMatchObject({ evidencePolicy: "entitled-institutional", capabilityProfile: "evidence-only" });
  });

  it("re-checks on premises at dispatch: items left when the configuration changes are refused without a call", async () => {
    const { runtime, socket, up, judge } = await turn({ onPremises: true, hold: true });
    const job = (await unix(socket, "/bulk/submit", { configId: "w1", idempotencyKey: "entitled", concurrency: 1, items: [{ id: "one", input: "first" }, { id: "two", input: "second" }] })).body;
    for (let i = 0; i < 400 && up.calls.length === 0; i++) await delay(5);
    runtime.useWorkerPolicy({ enabled: true, onPremises: new Map([[judge.id, { ...judge, baseUrl: "http://127.0.0.1:1/v1" }]]) });
    up.release();
    const done = await settled(runtime, job.jobId);
    expect(done.results.map((result) => [result.id, result.state, result.errorCode ?? null])).toEqual([["one", "completed", null], ["two", "failed", PROVIDER_NOT_ON_PREMISES]]);
    expect(up.calls).toHaveLength(1);
  });

  it("starts no agent for evidence-only workers or for run-fixed-programs and code-authoring workers that are not Claude", async () => {
    const { runtime, socket, started } = await turn();
    for (const configId of ["w1", "w2", "w3", "w7"]) {
      const refused = await unix(socket, "/agent/submit", { configId, idempotencyKey: `agent-${configId}`, task: "Do the work." });
      expect(refused, configId).toMatchObject({ status: 403, body: { code: CAPABILITY_PROFILE_DENIED } });
    }
    expect(started).toEqual([]);
    expect(runtime.store.jobHeaders("main")).toEqual([]);
    // Claude workers run as agents, whether they author code or run fixed programs (coscila's wrapper mounts the
    // latter's workspace read-only); so does a worker without a profile.
    for (const configId of ["w4", "w5", "w8"]) {
      const job = (await unix(socket, "/agent/submit", { configId, idempotencyKey: `agent-${configId}`, task: "Do the work." })).body;
      expect((await settled(runtime, job.jobId)).state, configId).toBe("completed");
    }
    expect(started).toHaveLength(3);
  });

  it("lets a worker with pinned instruments run only those, and a run-fixed-programs worker that is not Claude nothing else", async () => {
    const { runtime, socket, up } = await turn();
    runtime.installInstrument(WRAPPED, bundle());
    runtime.installInstrument(OTHER, bundle({ instrumentId: "other-tool@2", version: 2 }));
    const free = await unix(socket, "/bulk/submit", { configId: "w2", idempotencyKey: "free", items: [{ id: "one", input: "free-form prompt" }] });
    expect(free).toMatchObject({ status: 403, body: { code: INSTRUMENT_REQUIRED } });
    const other = await unix(socket, "/bulk/submit", { configId: "w2", idempotencyKey: "other", instrumentDigest: OTHER, items: [{ id: "one", input: "entry" }] });
    expect(other).toMatchObject({ status: 403, body: { code: INSTRUMENT_NOT_PINNED } });
    const unpinned = await unix(socket, "/bulk/submit", { configId: "w3", idempotencyKey: "unpinned", instrumentDigest: WRAPPED, items: [{ id: "one", input: "entry" }] });
    expect(unpinned).toMatchObject({ status: 403, body: { code: INSTRUMENT_REQUIRED } });
    expect(up.calls).toHaveLength(0);
    const pinned = (await unix(socket, "/bulk/submit", { configId: "w2", idempotencyKey: "pinned", instrumentDigest: WRAPPED, items: [{ id: "one", input: "entry" }] })).body;
    expect((await settled(runtime, pinned.jobId)).state).toBe("completed");
    expect(up.calls).toHaveLength(1);
    // A worker without policy is unaffected by any of this.
    const plain = (await unix(socket, "/bulk/submit", { configId: "w8", idempotencyKey: "plain", items: [{ id: "one", input: "free-form prompt" }] })).body;
    expect((await settled(runtime, plain.jobId)).state).toBe("completed");
  });

  it("refuses every worker policy field while PUPPENCLAW_WORKER_POLICY is off, and runs legacy configurations as before", async () => {
    await expect(turn({ enabled: false })).rejects.toMatchObject({ code: WORKER_POLICY_DISABLED });
    process.env.TEST_MODEL_KEY = "test-secret";
    const runtime = await AdvancedRuntime.open(await dataRoot(), { defaultLimit: 4 });
    cleanups.push(() => runtime.close());
    runtime.useWorkerPolicy({ enabled: false, onPremises: new Map() });
    const judge = judgeProvider("http://127.0.0.1:9/v1");
    const params = startParamsZod.parse({ name: "main", agent: "codex", directory: "/tmp", task: "review", interactionMode: "execute", permissionMode: "approve-all",
      statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt" }, modelProvider: judge,
      orchestration: { version: 1, revision: 1, workers: [{ id: "refs", assignment: "Check sources", evidencePolicy: "public-literature", agent: "codex", modelProvider: judge }] } });
    const session = { ...params, state: "idle", warnings: [], transcript: [], createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() } as unknown as SessionInfo;
    runtime.attach({ start: async () => ({ content: [], details: {} }), quiesce: async () => {}, getSession: () => session, contribution: () => {} });
    await runtime.begin(session, params, "approve-all");
    expect((await unix(runtime.socket("main")!, "/configs")).body.workers[0]).toMatchObject({ id: "refs", evidencePolicy: "public-literature", bulkAvailable: true });
  });
});

describe("worker policy on the daemon", () => {
  const AUTH = { authorization: "Bearer worker-policy-token" };
  async function daemon(env: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    const { app } = await createDaemonServer({ config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand(), daemonAuthToken: "worker-policy-token" }), dataDir: await createTempDir("pcwp-daemon-") });
    cleanups.push(() => app.close());
    return app;
  }

  it("advertises workerPolicy in /capabilities and /v2/capabilities, with the on-premises providers it configured", async () => {
    const plain = await daemon();
    expect((await plain.inject({ method: "GET", url: "/capabilities" })).json().advancedOrchestration).toMatchObject({ workerPolicy: 1, workerJoinContinuation: true });
    const v2 = (await plain.inject({ method: "GET", url: "/v2/capabilities", headers: AUTH })).json();
    expect(v2.features).toMatchObject({ workerPolicy: 1, brokerOutbox: 2 });
    expect(v2.advancedOrchestration).toEqual({ workerPolicy: 1, evidencePolicies: ["public-literature", "entitled-institutional", "confidential-manuscript"], capabilityProfiles: ["code-authoring", "evidence-only", "run-fixed-programs"], onPremisesProviders: [], identifierOnlyEgress: "coscila" });
    await plain.close();
    const judge = judgeProvider("http://127.0.0.1:18160/v1");
    const configured = await daemon({ PUPPENCLAW_MODEL_PROVIDERS: JSON.stringify([judge, { ...judge, id: "remote_qwen38_low" }]), PUPPENCLAW_ONPREM_PROVIDERS: JSON.stringify(["remote_qwen38_none", "remote_qwen38_low"]) });
    expect((await configured.inject({ method: "GET", url: "/v2/capabilities", headers: AUTH })).json().advancedOrchestration.onPremisesProviders).toEqual(["remote_qwen38_low", "remote_qwen38_none"]);
  });

  it("advertises nothing and refuses the fields with PUPPENCLAW_WORKER_POLICY=off, and fails startup on invalid settings", async () => {
    const off = await daemon({ PUPPENCLAW_WORKER_POLICY: "off" });
    expect((await off.inject({ method: "GET", url: "/capabilities" })).json().advancedOrchestration).not.toHaveProperty("workerPolicy");
    const v2 = (await off.inject({ method: "GET", url: "/v2/capabilities", headers: AUTH })).json();
    expect(v2.features).not.toHaveProperty("workerPolicy");
    expect(v2).not.toHaveProperty("advancedOrchestration");
    // Refused before any session state changes; a legacy orchestration still passes this check.
    const judge = judgeProvider("http://127.0.0.1:9/v1");
    const payload = (worker: Record<string, unknown>) => ({ name: "off", agent: "codex", directory: "/tmp", task: "review", modelProvider: judge,
      statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt" }, orchestration: { version: 1, revision: 1, workers: [{ id: "w1", assignment: "Judge", agent: "codex", modelProvider: judge, ...worker }] } });
    for (const url of ["/session/start", "/session/start/stream"]) {
      const refused = await off.inject({ method: "POST", url, headers: AUTH, payload: payload({ capabilityProfile: "evidence-only" }) });
      expect(refused.statusCode, url).toBe(400);
      expect(refused.json(), url).toMatchObject({ ok: false, code: WORKER_POLICY_DISABLED });
    }
    expect((await off.inject({ method: "GET", url: "/session/off?view=summary", headers: AUTH })).json()).toMatchObject({ code: "NO_SESSION" });
    await off.close();
    delete process.env.PUPPENCLAW_WORKER_POLICY;
    await expect(daemon({ PUPPENCLAW_ONPREM_PROVIDERS: JSON.stringify(["remote_qwen38_none"]) })).rejects.toThrow(/does not configure/u);
    delete process.env.PUPPENCLAW_ONPREM_PROVIDERS;
    await expect(daemon({ PUPPENCLAW_WORKER_POLICY: "maybe" })).rejects.toThrow(/on or off/u);
  });

  it("answers an unknown evidence policy or profile on start with its typed code", async () => {
    const app = await daemon();
    const judge = judgeProvider("http://127.0.0.1:9/v1");
    const start = (worker: Record<string, unknown>) => app.inject({ method: "POST", url: "/session/start", headers: AUTH, payload: {
      name: "typed", agent: "codex", directory: "/tmp", task: "review", modelProvider: judge,
      statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt" },
      orchestration: { version: 1, revision: 1, workers: [{ id: "w1", assignment: "Judge", agent: "codex", modelProvider: judge, ...worker }] }
    } });
    for (const [worker, code] of [
      [{ evidencePolicy: "tenant-confidential" }, UNSUPPORTED_EVIDENCE_POLICY],
      [{ capabilityProfile: "network-free" }, UNSUPPORTED_CAPABILITY_PROFILE],
      [{ evidencePolicy: "entitled-institutional" }, INVALID_WORKER_POLICY]
    ] as const) {
      const response = await start(worker);
      expect(response.statusCode, code).toBe(400);
      expect(response.json(), code).toMatchObject({ ok: false, code });
    }
  });
});
