import { createServer, request, type RequestListener, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";

import { PrincipalRegistry } from "../../src/advanced/principals.js";
import { PrincipalStore } from "../../src/advanced/principals-store.js";
import {
  legacyAttemptAuthorityFromEnvironment,
  modelProvidersFromEnvironment
} from "../../src/advanced/principals-schema.js";
import { AdvancedRuntime } from "../../src/advanced/runtime.js";
import type { UsageReceipt } from "../../src/advanced/types.js";
import { startParamsZod } from "../../src/shared/schema.js";
import type { ModelProviderConfig, SessionInfo } from "../../src/shared/types.js";

const OWNER = "owner-key-0123456789abcdef";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  delete process.env.TEST_MODEL_KEY;
  delete process.env.PUPPENCLAW_ORCHESTRATION_ATTEMPT_ID;
  delete process.env.PUPPENCLAW_PRINCIPAL_ID;
});

// Short paths keep every socket well inside the 107-byte unix socket limit.
const dataRoot = () => mkdtemp(join("/tmp", "pcp3-"));
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Condition not reached in time.");
    await delay(5);
  }
}

type Upstream = { url: string; calls: number; starts: number[]; bodies: Record<string, unknown>[]; maxActive: number; release: () => void; hold: boolean };
/** A Responses-API fake: each call reports 10 input and 2 output tokens unless `usage` is false; `hold` keeps calls open until released. */
async function upstream(options: { hold?: boolean; delayMs?: number; usage?: boolean } = {}): Promise<Upstream> {
  const pending: (() => void)[] = [];
  let active = 0;
  const state: Upstream = { url: "", calls: 0, starts: [], bodies: [], maxActive: 0, release: () => { while (pending.length) pending.shift()!(); }, hold: options.hold ?? false };
  const handler: RequestListener = async (req, res: ServerResponse) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    try { state.bodies.push(JSON.parse(text) as Record<string, unknown>); } catch { state.bodies.push({}); }
    state.calls += 1;
    state.starts.push(performance.now());
    active += 1;
    state.maxActive = Math.max(state.maxActive, active);
    const finish = () => {
      active -= 1;
      if (res.destroyed) return;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "test-model", output_text: "verified", ...(options.usage === false ? {} : { usage: { input_tokens: 10, output_tokens: 2 } }) }));
    };
    if (state.hold) pending.push(finish);
    else if (options.delayMs) setTimeout(finish, options.delayMs);
    else finish();
  };
  const server = createServer(handler);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  state.url = `http://127.0.0.1:${address.port}/v1`;
  cleanups.push(async () => { state.release(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  return state;
}

function provider(id: string, baseUrl: string): ModelProviderConfig {
  return { id, model: "test-model", kind: "codex-openai-compatible", baseUrl, authTokenEnv: "TEST_MODEL_KEY" };
}

type Harness = { runtime: AdvancedRuntime; registry: PrincipalRegistry; dataDir: string; close: () => Promise<void> };
async function harness(options: { dataDir?: string; providers?: ModelProviderConfig[]; legacy?: boolean; now?: () => number } = {}): Promise<Harness> {
  process.env.TEST_MODEL_KEY = "test-secret";
  const dataDir = options.dataDir ?? await dataRoot();
  const runtime = await AdvancedRuntime.open(join(dataDir, "advanced"), { defaultLimit: 60 });
  let registry: PrincipalRegistry | undefined;
  runtime.attach({
    start: async () => ({ content: [{ type: "text", text: "done" }], details: { output: "done", session: { state: "completed" } } }),
    quiesce: async () => {},
    getSession: () => null,
    // Budgets are charged by the runtime itself as calls settle (the daemon's hooks are batched).
    contribution: () => {}
  });
  registry = await PrincipalRegistry.open({
    dataDir, runtime, providers: new Map((options.providers ?? []).map((p) => [p.id, p])),
    legacyAttemptAuthority: options.legacy ?? true, ...(options.now ? { now: options.now } : {})
  });
  // As the daemon does: principals reattach first, then broker recovery may relaunch their jobs.
  await runtime.recover();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await registry!.shutdown();
    await runtime.close();
    await registry!.close();
  };
  cleanups.push(close);
  return { runtime, registry, dataDir, close };
}

function grants(overrides: Record<string, unknown> = {}) {
  return { providers: ["judge"], instruments: [], maxConcurrency: 4, maxItems: null, tokenBudget: null, expiresAt: null, ...overrides };
}
function runBody(overrides: Record<string, unknown> = {}, grantOverrides: Record<string, unknown> = {}) {
  return { kind: "run", runId: "study-1", ownerKey: OWNER, grants: grants(grantOverrides), socket: true, ...overrides };
}

function unix(socketPath: string, path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false, method: options.method ?? (options.body === undefined ? "GET" : "POST"), headers: { "content-type": "application/json", ...options.headers } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.once("end", () => { let body: unknown; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: res.statusCode!, body }); });
      res.once("error", reject);
    });
    req.once("error", reject);
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}
const items = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, input: "Review" }));
async function settledJob(runtime: AdvancedRuntime, jobId: string, timeoutMs = 5_000) {
  await until(() => !["queued", "running"].includes(runtime.store.jobHeader(jobId)!.state), timeoutMs);
  await runtime.settled(jobId);
  return runtime.store.job(jobId)!;
}

describe("run principal records", () => {
  it("answers the same body with the same result and audits only real grant changes", async () => {
    const { registry } = await harness();
    const first = await registry.put("run:study-1", runBody({ socket: false }, { providers: ["judge", "other"] }));
    expect(first).toMatchObject({ principalId: "run:study-1", kind: "run", runId: "study-1", socketPath: null });
    expect(first).not.toHaveProperty("ownerKey");
    await delay(5);
    expect(await registry.put("run:study-1", runBody({ socket: false }, { providers: ["judge", "other"] }))).toEqual(first);
    // The same sets in another order are the same grants.
    expect(await registry.put("run:study-1", runBody({ socket: false }, { providers: ["other", "judge"] }))).toEqual(first);
    expect(registry.detail("run:study-1")!.audit.map((entry) => entry.action)).toEqual(["created"]);

    const raised = await registry.put("run:study-1", runBody({ socket: false }, { providers: ["judge", "other"], maxItems: 10 }));
    expect(raised.createdAt).toBe(first.createdAt);
    expect(raised.grants.maxItems).toBe(10);
    const detail = registry.detail("run:study-1")!;
    expect(detail.revision).toBe(2);
    expect(detail.audit.map((entry) => entry.action)).toEqual(["created", "updated"]);
    expect(detail.audit[1]).toMatchObject({ before: { grants: { maxItems: null } }, after: { grants: { maxItems: 10 } } });
  });

  it("keeps kind, runId and ownerKey immutable and refuses a revoked id", async () => {
    const { registry } = await harness();
    await registry.put("run:study-1", runBody({ socket: false }));
    await expect(registry.put("run:study-1", runBody({ socket: false, runId: "study-2" }))).rejects.toMatchObject({ code: "PRINCIPAL_CONFLICT" });
    await expect(registry.put("run:study-1", runBody({ socket: false, ownerKey: "another-owner-key-0123456789" }))).rejects.toMatchObject({ code: "PRINCIPAL_CONFLICT" });
    const revoked = await registry.revoke("run:study-1");
    expect(await registry.revoke("run:study-1")).toEqual(revoked);
    await expect(registry.put("run:study-1", runBody({ socket: false }))).rejects.toMatchObject({ code: "PRINCIPAL_REVOKED" });
    expect(registry.detail("run:study-1")).toMatchObject({ state: "revoked", revokedAt: revoked.revokedAt });
  });

  it("validates kinds: a run is bound to a runId, a human carries none and no credential logic", async () => {
    const { registry } = await harness();
    await expect(registry.put("run:x", runBody({ runId: null }))).rejects.toThrow(/runId/);
    await expect(registry.put("hp_alice", runBody({ kind: "human", runId: "study-1" }))).rejects.toThrow(/runId/);
    await expect(registry.put("bad id", runBody())).rejects.toThrow();
    const human = await registry.put("hp_alice", runBody({ kind: "human", runId: null, socket: false }));
    expect(human).toMatchObject({ kind: "human", runId: null, socketPath: null });
  });

  it("refuses a principal whose name a chat participant holds, before storing anything", async () => {
    const { runtime, registry } = await harness();
    // A chat participant named like a principal (never done by the lab, which names chats lab-<chatId>).
    (runtime as unknown as { participants: Map<string, unknown> }).participants.set("principal:run:clash", { sessionName: "principal:run:clash" });
    await expect(registry.put("run:clash", runBody({ socket: false }))).rejects.toMatchObject({ code: "PRINCIPAL_NAME_CONFLICT" });
    expect(registry.detail("run:clash")).toBeNull();
  });
});

describe("principal sockets", () => {
  it("are private sockets in private directories under the daemon data directory", async () => {
    const { registry, dataDir } = await harness();
    const view = await registry.put("run:study-1", runBody());
    expect(view.socketPath!.startsWith(join(dataDir, "principals") + "/")).toBe(true);
    expect(Buffer.byteLength(view.socketPath!)).toBeLessThanOrEqual(107);
    expect((await stat(view.socketPath!)).mode & 0o777).toBe(0o600);
    expect((await stat(join(view.socketPath!, ".."))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dataDir, "principals"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dataDir, "principals", "principals.sqlite"))).mode & 0o777).toBe(0o600);
  });

  it("return the principal identity from GET /configs; no header, body field or environment variable changes it", async () => {
    const service = await upstream();
    const { registry } = await harness({ providers: [provider("judge", service.url)] });
    const a = (await registry.put("run:a", runBody({ runId: "a" }))).socketPath!;
    const b = (await registry.put("run:b", runBody({ runId: "b" }))).socketPath!;
    process.env.PUPPENCLAW_ORCHESTRATION_ATTEMPT_ID = "run:b";
    process.env.PUPPENCLAW_PRINCIPAL_ID = "run:b";
    const configs = await unix(a, "/configs", { headers: { "x-puppenclaw-principal": "run:b", "x-puppenclaw-attempt-id": "run:b", authorization: "Bearer run:b" } });
    expect(configs.status).toBe(200);
    expect(configs.body.authorization).toMatchObject({ principalId: "run:a", attemptId: "run:a", runId: "a", kind: "run", state: "active", publicLiteratureAllowed: true });
    expect(configs.body.workers).toEqual([expect.objectContaining({ id: "judge", providerId: "judge", bulkAvailable: true, bulkConcurrencyLimit: 4 })]);

    // A body field naming another principal is refused, and B's work stays invisible through A's socket.
    const forged = await unix(a, "/bulk/submit", { body: { configId: "judge", idempotencyKey: "forged", principalId: "run:b", items: items("f", 1) } });
    expect(forged).toMatchObject({ status: 400, body: { code: "INVALID_REQUEST" } });
    const ofB = await unix(b, "/bulk/submit?view=summary", { body: { configId: "judge", idempotencyKey: "b-1", items: items("b", 1) } });
    expect(ofB.status).toBe(200);
    expect(ofB.body).toMatchObject({ attemptId: "run:b", parentSessionName: "principal:run:b" });
    expect((await unix(a, `/jobs/${ofB.body.jobId}?view=summary`, { headers: { "x-puppenclaw-principal": "run:b" } })).status).toBe(404);
    expect((await unix(a, `/jobs/${ofB.body.jobId}/results`)).status).toBe(404);
    expect((await unix(a, "/jobs?view=summary")).body.jobs).toEqual([]);
  });

  it("serve no native model routes, proxies or tunnels and no agent workers", async () => {
    const service = await upstream();
    const { registry } = await harness({ providers: [provider("judge", service.url)] });
    const socket = (await registry.put("run:a", runBody())).socketPath!;
    expect((await unix(socket, "/native/v1/responses", { body: { model: "test-model", input: "x" } })).body.code).toBe("UNKNOWN_PRINCIPAL_ROUTE");
    expect((await unix(socket, "http://example.com/", {})).body.code).toBe("UNKNOWN_PRINCIPAL_ROUTE");
    expect(await unix(socket, "/agent/submit", { body: { configId: "judge", idempotencyKey: "a", task: "x" } })).toMatchObject({ status: 403, body: { code: "PRINCIPAL_AGENT_UNSUPPORTED" } });
    const tunnel = await new Promise<string>((resolve) => {
      const client = connect(socket, () => client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"));
      let text = "";
      client.on("data", (chunk) => { text += chunk; });
      client.on("close", () => resolve(text));
      client.on("error", () => resolve(text));
    });
    expect(tunnel).not.toContain("200");
    expect(service.calls).toBe(0);
  });

  it("persist and reopen at the same path after a restart, keeping usage and the directory a sandbox may have bound", async () => {
    const service = await upstream();
    const first = await harness({ providers: [provider("judge", service.url)] });
    const view = await first.registry.put("run:a", runBody());
    await first.registry.put("run:gone", runBody({ runId: "gone" }));
    const gone = first.registry.detail("run:gone")!.socketPath!;
    const job = await unix(view.socketPath!, "/bulk/submit", { body: { configId: "judge", idempotencyKey: "k", items: items("r", 2) } });
    expect((await settledJob(first.runtime, job.body.jobId)).state).toBe("completed");
    await first.registry.revoke("run:gone");
    const directory = await stat(join(view.socketPath!, ".."));
    await first.close();

    const second = await harness({ dataDir: first.dataDir, providers: [provider("judge", service.url)] });
    expect(second.registry.socketBinding("run:a")).toEqual({ principalId: "run:a", directory: join(view.socketPath!, ".."), path: view.socketPath });
    expect((await stat(join(view.socketPath!, ".."))).ino).toBe(directory.ino);
    expect((await stat(view.socketPath!)).mode & 0o777).toBe(0o600);
    const configs = await unix(view.socketPath!, "/configs");
    expect(configs.body.authorization.principalId).toBe("run:a");
    expect(configs.body.principal.usage).toMatchObject({ items: 2, inputTokens: 20, outputTokens: 4 });
    expect((await unix(view.socketPath!, `/jobs/${job.body.jobId}?view=summary`)).body.state).toBe("completed");
    expect(second.registry.socketBinding("run:gone")).toBeNull();
    await expect(stat(gone)).rejects.toMatchObject({ code: "ENOENT" });
    expect(second.registry.detail("run:gone")!.state).toBe("revoked");
  });

  it("close when the socket grant is withdrawn and open in a new directory when it is granted again", async () => {
    const { registry } = await harness();
    const on = (await registry.put("run:a", runBody())).socketPath!;
    expect((await registry.put("run:a", runBody({ socket: false }))).socketPath).toBeNull();
    await expect(stat(on)).rejects.toMatchObject({ code: "ENOENT" });
    const again = (await registry.put("run:a", runBody())).socketPath!;
    expect(again).not.toBe(on);
    expect((await unix(again, "/configs")).body.authorization.principalId).toBe("run:a");
  });
});

describe("grant enforcement", () => {
  it("never lets a principal use a provider or instrument outside its grants", async () => {
    const service = await upstream();
    const { registry, runtime } = await harness({ providers: [provider("judge", service.url), provider("other", service.url)] });
    const socket = (await registry.put("run:a", runBody())).socketPath!;
    expect((await unix(socket, "/configs")).body.workers.map((w: { id: string }) => w.id)).toEqual(["judge"]);
    expect(await unix(socket, "/bulk/submit", { body: { configId: "other", idempotencyKey: "o", items: items("o", 1) } })).toMatchObject({ status: 403, body: { code: "PROVIDER_NOT_GRANTED" } });
    expect(await unix(socket, "/bulk/submit", { body: { configId: "unknown", idempotencyKey: "u", items: items("u", 1) } })).toMatchObject({ status: 404, body: { code: "WORKER_CONFIG_NOT_FOUND" } });
    expect(await unix(socket, "/bulk/submit", { body: { configId: "judge", idempotencyKey: "i", instrumentDigest: "f".repeat(64), items: items("i", 1) } })).toMatchObject({ status: 403, body: { code: "INSTRUMENT_NOT_GRANTED" } });

    // A principal granted instruments may run nothing but them.
    const withInstrument = (await registry.put("run:b", runBody({ runId: "b" }, { instruments: ["a".repeat(64)] }))).socketPath!;
    expect(await unix(withInstrument, "/bulk/submit", { body: { configId: "judge", idempotencyKey: "n", items: items("n", 1) } })).toMatchObject({ status: 403, body: { code: "INSTRUMENT_REQUIRED" } });
    const participant = { principalId: "run:b", sessionName: "principal:run:b" } as never;
    const config = { id: "judge", assignment: "x", agent: "codex", modelProvider: provider("judge", service.url) } as never;
    expect(() => registry.admitJob(participant, "bulk", { configId: "judge", idempotencyKey: "x", items: [], concurrency: 1, instrumentDigest: "b".repeat(64) } as never, config)).toThrow(expect.objectContaining({ code: "INSTRUMENT_NOT_GRANTED" }));
    expect(() => registry.admitJob(participant, "bulk", { configId: "judge", idempotencyKey: "x", items: [], concurrency: 1, instrumentDigest: "a".repeat(64) } as never, config)).not.toThrow();
    expect(() => registry.admitJob(participant, "bulk", { configId: "judge", idempotencyKey: "x", items: [], concurrency: 1 } as never, { ...(config as object), modelProvider: provider("other", service.url) } as never)).toThrow(expect.objectContaining({ code: "PROVIDER_NOT_GRANTED" }));
    expect(registry.refusal(participant, { config: { modelProvider: { id: "judge" } }, request: { instrumentDigest: "b".repeat(64) } } as never)).toBe("grant_withdrawn");
    expect(registry.refusal(participant, { config: { modelProvider: { id: "judge" } }, request: { instrumentDigest: "a".repeat(64) } } as never)).toBeUndefined();
    expect(service.calls).toBe(0);
    expect(runtime.store.jobHeaders("principal:run:a")).toEqual([]);
  });

  it("gates instrument mode: grants restrict which installed instruments a principal runs; events carry principalId, runId and provenance", async () => {
    const service = await upstream();
    const { registry, runtime } = await harness({ providers: [provider("judge", service.url)] });
    const bundle = { instrumentId: "census-judge", version: 1, systemPrompt: "Judge each citation.", responseSchema: null, maxOutputTokens: { perItem: 64, minimum: 128 }, temperature: 0, seed: 7, reasoning: "none", itemsPerCall: 4, requiredModelFingerprint: null };
    const [granted, missing, ungranted] = ["a", "b", "c"].map((c) => c.repeat(64));
    runtime.installInstrument(granted!, bundle);
    runtime.installInstrument(ungranted!, { ...bundle, systemPrompt: "Another instrument." });
    const socket = (await registry.put("run:i", runBody({ runId: "study-i" }, { instruments: [granted, missing] }))).socketPath!;
    expect((await unix(socket, "/configs")).body).toMatchObject({ instrumentMode: 1, instruments: [{ digest: granted, instrumentId: "census-judge", version: 1, itemsPerCall: 4 }] });
    // Granted but not installed: the allow-list still refuses it. Installed but not granted: the grant refuses it.
    expect(await unix(socket, "/bulk/submit", { body: { configId: "judge", idempotencyKey: "m", instrumentDigest: missing, items: items("m", 1) } })).toMatchObject({ status: 400, body: { code: "INSTRUMENT_NOT_ALLOWED" } });
    expect(await unix(socket, "/bulk/submit", { body: { configId: "judge", idempotencyKey: "u", instrumentDigest: ungranted, items: items("u", 1) } })).toMatchObject({ status: 403, body: { code: "INSTRUMENT_NOT_GRANTED" } });
    expect(service.calls).toBe(0);
    const job = (await unix(socket, "/bulk/submit?view=summary", { body: { configId: "judge", idempotencyKey: "g", instrumentDigest: granted, items: items("g", 3) } })).body;
    expect(job).toMatchObject({ instrumentDigest: granted });
    expect(await settledJob(runtime, job.jobId)).toMatchObject({ state: "completed", principalId: "run:i", runId: "study-i" });
    // Instrument settings reached the upstream: worker policy plus instrument prompt, max(minimum, perItem x items), sampling.
    expect(service.bodies).toHaveLength(3);
    for (const sent of service.bodies) {
      expect(sent).toMatchObject({ max_output_tokens: 128, temperature: 0, seed: 7, reasoning: { effort: "none" } });
      expect(String((sent.input as { content: string }[])[0]!.content)).toMatch(/\n\nJudge each citation\.$/u);
    }
    const events = runtime.store.events(0, 1000).events.filter((event) => event.jobId === job.jobId);
    const jobEvents = events.filter((event) => event.type === "broker.job").map((event) => event.payload);
    expect(jobEvents.at(-1)).toMatchObject({ principalId: "run:i", runId: "study-i", instrumentDigest: granted, state: "completed", counts: { total: 3, succeeded: 3 } });
    expect(jobEvents.every((payload) => (payload as { principalId: string }).principalId === "run:i")).toBe(true);
    const receipts = events.filter((event) => event.type === "broker.receipt").map((event) => event.payload);
    expect(receipts).toHaveLength(3);
    for (const receipt of receipts) expect(receipt).toMatchObject({ status: "succeeded", instrumentDigest: granted, serverFingerprint: expect.stringMatching(/\S/u), settingsSha256: expect.stringMatching(/^[0-9a-f]{64}$/u), usage: { input: 10, output: 2 } });
    expect(registry.detail("run:i")!.usage).toMatchObject({ items: 3, inputTokens: 30, outputTokens: 6 });
  });

  it("pauses running work when a provider grant is withdrawn and makes no further calls", async () => {
    const service = await upstream({ hold: true });
    const { registry, runtime } = await harness({ providers: [provider("judge", service.url), provider("other", service.url)] });
    const socket = (await registry.put("run:a", runBody({}, { providers: ["judge", "other"], maxConcurrency: 1 }))).socketPath!;
    const job = (await unix(socket, "/bulk/submit?view=summary", { body: { configId: "judge", idempotencyKey: "w", concurrency: 4, items: items("w", 5) } })).body;
    await until(() => service.calls === 1);
    await registry.put("run:a", runBody({}, { providers: ["other"], maxConcurrency: 1 }));
    service.hold = false;
    service.release();
    const settled = await settledJob(runtime, job.jobId);
    expect(settled).toMatchObject({ state: "paused", error: "grant_withdrawn" });
    expect(service.calls).toBe(1);
    expect(settled.results.filter((r) => r.state === "completed")).toHaveLength(1);
    expect((await unix(socket, `/jobs/${job.jobId}/resume`, { method: "POST" })).body.code).toBe("GRANT_WITHDRAWN");
  });

  it("bounds concurrent calls across all of a principal's jobs by maxConcurrency", async () => {
    const service = await upstream({ delayMs: 20 });
    const { registry, runtime } = await harness({ providers: [provider("judge", service.url)] });
    const socket = (await registry.put("run:a", runBody({}, { maxConcurrency: 2 }))).socketPath!;
    const jobs = await Promise.all(["x", "y"].map(async (key) => (await unix(socket, "/bulk/submit?view=summary", { body: { configId: "judge", idempotencyKey: key, concurrency: 5, items: items(key, 5) } })).body.jobId as string));
    for (const id of jobs) expect((await settledJob(runtime, id)).state).toBe("completed");
    expect(service.calls).toBe(10);
    expect(service.maxActive).toBe(2);
    expect(registry.detail("run:a")!.usage).toMatchObject({ items: 10, activeItems: 0 });
  });
});

describe("principal budgets", () => {
  it("pauses with budget_exhausted when the token budget is spent and resumes after a PUT raises it", async () => {
    const service = await upstream();
    const { registry, runtime } = await harness({ providers: [provider("judge", service.url)] });
    const body = (input: number) => runBody({}, { maxConcurrency: 1, tokenBudget: { input, output: null } });
    const socket = (await registry.put("run:a", body(25))).socketPath!;
    const job = (await unix(socket, "/bulk/submit?view=summary", { body: { configId: "judge", idempotencyKey: "b", concurrency: 1, items: items("b", 5) } })).body;
    const paused = await settledJob(runtime, job.jobId);
    // 10 input tokens per call: 0, 10 and 20 are below 25, 30 is not.
    expect(paused).toMatchObject({ state: "paused", error: "budget_exhausted" });
    expect(service.calls).toBe(3);
    expect(registry.detail("run:a")!.usage).toMatchObject({ items: 3, inputTokens: 30, outputTokens: 6, remaining: { inputTokens: 0, items: null } });
    expect(await unix(socket, `/jobs/${job.jobId}/resume`, { method: "POST" })).toMatchObject({ status: 409, body: { code: "BUDGET_EXHAUSTED" } });

    await registry.put("run:a", body(1_000));
    expect(registry.detail("run:a")!.audit.map((entry) => entry.action)).toEqual(["created", "updated"]);
    const resumed = await unix(socket, `/jobs/${job.jobId}/resume`, { method: "POST" });
    expect(resumed.status).toBe(200);
    const done = await settledJob(runtime, resumed.body.jobId as string);
    expect(done).toMatchObject({ state: "completed", resumedFromJobId: job.jobId, principalId: "run:a", runId: "study-1" });
    expect(done.results).toHaveLength(2);
    expect(service.calls).toBe(5);
  });

  it("refuses items already waiting for a slot as soon as a settled call spends the budget", async () => {
    const service = await upstream();
    const { registry, runtime } = await harness({ providers: [provider("judge", service.url)] });
    const socket = (await registry.put("run:a", runBody({}, { maxConcurrency: 1, tokenBudget: { input: 15, output: null } }))).socketPath!;
    const job = (await unix(socket, "/bulk/submit?view=summary", { body: { configId: "judge", idempotencyKey: "w", concurrency: 5, items: items("w", 6) } })).body;
    const paused = await settledJob(runtime, job.jobId);
    expect(paused).toMatchObject({ state: "paused", error: "budget_exhausted" });
    expect(service.calls).toBe(2);
    expect(paused.results.filter((r) => r.state === "completed")).toHaveLength(2);
    expect(registry.detail("run:a")!.usage).toMatchObject({ items: 2, activeItems: 0, inputTokens: 20 });
    // The paused event came while refused waiters were still in flight; the drained job reports its final counts.
    const refused = paused.results.filter((r) => r.state === "paused").length;
    expect(refused).toBeGreaterThan(0);
    const jobEvents = runtime.store.events(0, 1000).events.filter((event) => event.type === "broker.job" && event.jobId === job.jobId).map((event) => event.payload as { state: string; counts: Record<string, number> });
    expect(jobEvents.at(-1)).toMatchObject({ state: "paused", counts: { total: 6, running: 0, succeeded: 2, failed: refused, queued: 4 - refused } });
  });

  it("cancels items waiting for a slot together with their job", async () => {
    const service = await upstream({ hold: true });
    const { registry, runtime } = await harness({ providers: [provider("judge", service.url)] });
    const socket = (await registry.put("run:a", runBody({}, { maxConcurrency: 1 }))).socketPath!;
    const job = (await unix(socket, "/bulk/submit?view=summary", { body: { configId: "judge", idempotencyKey: "c", concurrency: 3, items: items("c", 4) } })).body;
    await until(() => service.calls === 1);
    expect((await unix(socket, `/jobs/${job.jobId}/cancel`, { method: "POST" })).body.state).toBe("cancelled");
    await runtime.settled(job.jobId);
    service.release();
    await delay(20);
    expect(service.calls).toBe(1);
    expect(runtime.store.job(job.jobId)!.results.every((r) => r.state === "cancelled")).toBe(true);
    expect(registry.detail("run:a")!.usage.activeItems).toBe(0);
  });

  it("caps admitted items exactly at maxItems under concurrency", async () => {
    const service = await upstream({ delayMs: 10 });
    const { registry, runtime } = await harness({ providers: [provider("judge", service.url)] });
    const socket = (await registry.put("run:a", runBody({}, { maxConcurrency: 3, maxItems: 4 }))).socketPath!;
    const job = (await unix(socket, "/bulk/submit?view=summary", { body: { configId: "judge", idempotencyKey: "m", concurrency: 10, items: items("m", 10) } })).body;
    const paused = await settledJob(runtime, job.jobId);
    expect(paused).toMatchObject({ state: "paused", error: "budget_exhausted" });
    expect(service.calls).toBe(4);
    expect(paused.results.filter((r) => r.state === "completed")).toHaveLength(4);
    expect(registry.detail("run:a")!.usage.remaining.items).toBe(0);
  });

  it("pauses expired principals and resumes once coscila extends the expiry", async () => {
    const service = await upstream();
    let now = Date.parse("2026-10-25T12:00:00Z");
    const { registry, runtime } = await harness({ providers: [provider("judge", service.url)], now: () => now });
    const socket = (await registry.put("run:a", runBody({}, { expiresAt: "2026-10-25T13:00:00Z" }))).socketPath!;
    now = Date.parse("2026-10-25T13:00:01Z");
    expect((await unix(socket, "/configs")).body.authorization).toMatchObject({ state: "expired", publicLiteratureAllowed: false });
    expect(await unix(socket, "/bulk/submit", { body: { configId: "judge", idempotencyKey: "e", items: items("e", 1) } })).toMatchObject({ status: 409, body: { code: "PRINCIPAL_EXPIRED" } });
    await registry.put("run:a", runBody({}, { expiresAt: "2026-10-26T13:00:00Z" }));
    const job = await unix(socket, "/bulk/submit", { body: { configId: "judge", idempotencyKey: "e", items: items("e", 1) } });
    expect((await settledJob(runtime, job.body.jobId)).state).toBe("completed");
  });

  it("settles every item still waiting for a slot when the principal expires while they wait", async () => {
    // No usage: no settled receipt announces the expiry, only the refused waiters themselves.
    const service = await upstream({ hold: true, usage: false });
    let now = Date.parse("2026-10-25T12:00:00Z");
    const { registry, runtime } = await harness({ providers: [provider("judge", service.url)], now: () => now });
    const socket = (await registry.put("run:a", runBody({}, { maxConcurrency: 1, expiresAt: "2026-10-25T13:00:00Z" }))).socketPath!;
    const job = (await unix(socket, "/bulk/submit?view=summary", { body: { configId: "judge", idempotencyKey: "x", concurrency: 5, items: items("x", 6) } })).body;
    await until(() => service.calls === 1);
    now = Date.parse("2026-10-25T13:00:01Z");
    service.hold = false;
    service.release();
    const settled = await settledJob(runtime, job.jobId);
    expect(settled).toMatchObject({ state: "paused", error: "principal_expired" });
    expect(service.calls).toBe(1);
    expect(registry.detail("run:a")!.usage.activeItems).toBe(0);
  });

  it("charges a settled receipt once even when it is published twice", async () => {
    const { registry } = await harness();
    await registry.put("run:a", runBody({ socket: false }));
    const receipt = { version: 1, requestId: "r-1", parentSessionName: "principal:run:a", sessionName: "principal:run:a", attemptId: "run:a", providerId: "judge", model: "m", role: "subagent", promptSha256: "x", state: "completed", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 10, quality: "measured" }, createdAt: "", updatedAt: "" } satisfies UsageReceipt;
    registry.observeReceipt({ ...receipt, state: "running" });
    registry.observeReceipt(receipt);
    registry.observeReceipt(receipt);
    registry.observeReceipt({ ...receipt, requestId: "r-2", parentSessionName: "lab-chat" });
    expect(registry.detail("run:a")!.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });
});

describe("principal revocation", () => {
  it("closes admission within 5 s: in-flight items finish, nothing else starts, the rest is cancelled", async () => {
    const service = await upstream({ hold: true });
    const { registry, runtime } = await harness({ providers: [provider("judge", service.url)] });
    const socket = (await registry.put("run:a", runBody({}, { maxConcurrency: 2 }))).socketPath!;
    const job = (await unix(socket, "/bulk/submit?view=summary", { body: { configId: "judge", idempotencyKey: "r", concurrency: 6, items: items("r", 12) } })).body;
    await until(() => service.calls === 2);
    const started = performance.now();
    const { revokedAt } = await registry.revoke("run:a");
    const revokeMs = performance.now() - started;
    expect(typeof revokedAt).toBe("string");
    // Admission is closed: a connection to the socket now fails, and releasing the in-flight calls starts no new ones.
    await expect(stat(socket)).rejects.toMatchObject({ code: "ENOENT" });
    service.hold = false;
    service.release();
    const settled = await settledJob(runtime, job.jobId);
    await until(() => runtime.store.jobHeader(job.jobId)!.state === "cancelled");
    const final = runtime.store.job(job.jobId)!;
    const lateStarts = service.starts.filter((at) => at > started).length;
    console.info(`principal revoke: admission closed in ${revokeMs.toFixed(2)} ms; ${lateStarts} calls started afterwards; ${final.results.filter((r) => r.state === "completed").length} in-flight items finished`);
    expect(revokeMs).toBeLessThan(5_000);
    expect(lateStarts).toBe(0);
    expect(service.calls).toBe(2);
    expect(settled.results.filter((r) => r.state === "completed")).toHaveLength(2);
    expect(final.state).toBe("cancelled");
    expect(final.results.filter((r) => r.state === "cancelled")).toHaveLength(10);
    expect(registry.detail("run:a")).toMatchObject({ state: "revoked", socketPath: expect.any(String) });
    expect(registry.socketBinding("run:a")).toBeNull();
  });

  it("aborts in-flight calls with cancel", async () => {
    const service = await upstream({ hold: true });
    const { registry, runtime } = await harness({ providers: [provider("judge", service.url)] });
    const socket = (await registry.put("run:a", runBody({}, { maxConcurrency: 2 }))).socketPath!;
    const job = (await unix(socket, "/bulk/submit?view=summary", { body: { configId: "judge", idempotencyKey: "c", concurrency: 4, items: items("c", 6) } })).body;
    await until(() => service.calls === 2);
    await registry.revoke("run:a", { cancel: true });
    await runtime.settled(job.jobId);
    const final = runtime.store.job(job.jobId)!;
    expect(final.state).toBe("cancelled");
    expect(final.results.every((r) => r.state === "cancelled")).toBe(true);
    expect(service.calls).toBe(2);
    // The two calls in flight settled after the cancelled event; a last event carries the final counts.
    const lastJobEvent = () => runtime.store.events(0, 1000).events.filter((event) => event.type === "broker.job" && event.jobId === job.jobId).at(-1)!.payload as { state: string; counts: Record<string, number> };
    await until(() => lastJobEvent().counts.running === 0);
    expect(lastJobEvent()).toMatchObject({ state: "cancelled", counts: { total: 6, running: 0, queued: 0, cancelled: 6 } });
  });

  it("completes a revocation a restart interrupted: no socket reopens and paused work ends cancelled", async () => {
    const service = await upstream();
    const first = await harness({ providers: [provider("judge", service.url)] });
    const socket = (await first.registry.put("run:a", runBody({}, { maxItems: 1 }))).socketPath!;
    const job = (await unix(socket, "/bulk/submit?view=summary", { body: { configId: "judge", idempotencyKey: "i", items: items("i", 3) } })).body;
    expect((await settledJob(first.runtime, job.jobId)).state).toBe("paused");
    await first.close();
    // The revocation reached the store, then the daemon died before closing anything.
    const store = await PrincipalStore.open(join(first.dataDir, "principals"));
    store.revoke("run:a", new Date().toISOString(), null);
    store.close();
    await mkdir(join(socket, ".."), { recursive: true });
    await writeFile(socket, "");
    const second = await harness({ dataDir: first.dataDir, providers: [provider("judge", service.url)] });
    await expect(stat(join(socket, ".."))).rejects.toMatchObject({ code: "ENOENT" });
    expect(second.registry.socketBinding("run:a")).toBeNull();
    expect(second.runtime.store.jobHeader(job.jobId)).toMatchObject({ state: "cancelled" });
  });

  it("revokes every principal of an owner with cancel before account erasure", async () => {
    const { registry } = await harness();
    await registry.put("run:a", runBody());
    await registry.put("run:b", runBody({ runId: "b" }));
    await registry.put("run:c", runBody({ runId: "c", ownerKey: "another-owner-key-0123456789" }));
    await registry.revokeOwner(OWNER);
    expect(["run:a", "run:b", "run:c"].map((id) => registry.detail(id)!.state)).toEqual(["revoked", "revoked", "active"]);
  });
});

describe("daemon shutdown", () => {
  it("stops principal jobs without settling what is in flight; the next start relaunches them under the same job id", async () => {
    const service = await upstream({ hold: true });
    const first = await harness({ providers: [provider("judge", service.url)] });
    const socket = (await first.registry.put("run:a", runBody({}, { maxConcurrency: 2 }))).socketPath!;
    const job = (await unix(socket, "/bulk/submit?view=summary", { body: { configId: "judge", idempotencyKey: "s", concurrency: 2, items: items("s", 6) } })).body;
    await until(() => service.calls === 2);
    await first.close();
    service.hold = false;
    const second = await harness({ dataDir: first.dataDir, providers: [provider("judge", service.url)] });
    const done = await settledJob(second.runtime, job.jobId);
    expect(done).toMatchObject({ state: "completed", principalId: "run:a", runId: "study-1" });
    expect(done.results.map((r) => r.state)).toEqual(Array(6).fill("completed"));
    // The two calls aborted by the shutdown ran again; no resumed copy of the job exists.
    expect(service.calls).toBe(8);
    expect(second.runtime.store.jobHeaders("principal:run:a").map((header) => header.jobId)).toEqual([job.jobId]);
    // Exactly one receipt event per item; the aborted calls kept their transport receipts only.
    const events = second.runtime.store.events(0, 1000).events;
    const receipts = events.filter((event) => event.type === "broker.receipt");
    expect(receipts.map((event) => event.itemId).sort()).toEqual(items("s", 6).map((item) => item.id).sort());
    expect(receipts.every((event) => (event.payload as { status: string }).status === "succeeded")).toBe(true);
    expect(second.runtime.store.jobReceipts(job.jobId).filter((receipt) => receipt.state === "cancelled")).toHaveLength(2);
    const states = events.filter((event) => event.type === "broker.job").map((event) => (event.payload as { state: string; principalId: string | null; runId: string | null }));
    expect(states.every((payload) => payload.principalId === "run:a" && payload.runId === "study-1")).toBe(true);
    expect(states.map((payload) => payload.state)).toEqual(["queued", "running", "queued", "running", "completed"]);
  });

  it("leaves a job interrupted for an explicit resume when its principal no longer admits it after the restart", async () => {
    const service = await upstream({ hold: true });
    const first = await harness({ providers: [provider("judge", service.url)] });
    const socket = (await first.registry.put("run:a", runBody({}, { maxConcurrency: 1 }))).socketPath!;
    const job = (await unix(socket, "/bulk/submit?view=summary", { body: { configId: "judge", idempotencyKey: "x", concurrency: 1, items: items("x", 3) } })).body;
    await until(() => service.calls === 1);
    await first.close();
    service.hold = false;
    // The provider grant was withdrawn while the daemon was down.
    const store = await PrincipalStore.open(join(first.dataDir, "principals"));
    const record = store.get("run:a")!;
    store.save({ ...record, grants: { ...record.grants, providers: [] }, revision: record.revision + 1, updatedAt: new Date().toISOString() }, { action: "updated", before: null, after: null });
    store.close();
    const second = await harness({ dataDir: first.dataDir, providers: [provider("judge", service.url)] });
    expect(second.runtime.store.jobHeader(job.jobId)).toMatchObject({ state: "interrupted" });
    expect(second.runtime.store.job(job.jobId)!.results.map((r) => r.state)).toEqual(["queued", "queued", "queued"]);
    await second.registry.put("run:a", runBody({}, { maxConcurrency: 1 }));
    const resumed = await unix(socket, `/jobs/${job.jobId}/resume`, { method: "POST" });
    expect(resumed.status).toBe(200);
    expect((await settledJob(second.runtime, resumed.body.jobId as string)).state).toBe("completed");
  });
});

describe("legacy attempt authority", () => {
  async function chat(registryOptions: { legacy: boolean }) {
    const service = await upstream();
    const h = await harness({ providers: [provider("judge", service.url)], legacy: registryOptions.legacy });
    const modelProvider = provider("local", service.url);
    const params = startParamsZod.parse({ name: "main", agent: "codex", directory: "/tmp", task: "review", interactionMode: "execute", permissionMode: "approve-all", statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt" }, modelProvider, orchestration: { version: 1, revision: 1, workers: [{ id: "refs", assignment: "Check sources", agent: "codex", modelProvider }] } });
    const session = { ...params, state: "idle", warnings: [], transcript: [], createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() } as SessionInfo;
    await h.runtime.begin(session, params, "approve-all");
    return { ...h, service, socket: h.runtime.socket("main")! };
  }

  it("reads PUPPENCLAW_LEGACY_ATTEMPT_AUTHORITY strictly, on by default", () => {
    expect(legacyAttemptAuthorityFromEnvironment({})).toBe(true);
    expect(legacyAttemptAuthorityFromEnvironment({ PUPPENCLAW_LEGACY_ATTEMPT_AUTHORITY: "on" })).toBe(true);
    expect(legacyAttemptAuthorityFromEnvironment({ PUPPENCLAW_LEGACY_ATTEMPT_AUTHORITY: " OFF " })).toBe(false);
    expect(() => legacyAttemptAuthorityFromEnvironment({ PUPPENCLAW_LEGACY_ATTEMPT_AUTHORITY: "maybe" })).toThrow(/on or off/);
  });

  it("on: an approved execution turn keeps today's bulk authority and public-literature approval", async () => {
    const { socket, runtime } = await chat({ legacy: true });
    const configs = (await unix(socket, "/configs")).body;
    expect(configs.authorization).toMatchObject({ publicLiteratureAllowed: true, attemptId: "attempt" });
    expect(configs.workers[0].bulkAvailable).toBe(true);
    const job = await unix(socket, "/bulk/submit", { body: { configId: "refs", idempotencyKey: "legacy", items: items("l", 1) } });
    expect(job.status).toBe(200);
    expect((await settledJob(runtime, job.body.jobId)).state).toBe("completed");
    expect(runtime.environment("main").PUPPENCLAW_ORCHESTRATION_ATTEMPT_ID).toBe("attempt");
  });

  it("off: the attempt id and turn mode grant nothing; only a principal socket carries bulk authority", async () => {
    const { socket, runtime, registry, service } = await chat({ legacy: false });
    const configs = (await unix(socket, "/configs")).body;
    expect(configs.authorization).toMatchObject({ publicLiteratureAllowed: false, attemptId: "attempt" });
    expect(configs.workers[0].bulkAvailable).toBe(false);
    process.env.PUPPENCLAW_ORCHESTRATION_ATTEMPT_ID = "attempt";
    expect(await unix(socket, "/bulk/submit", { body: { configId: "refs", idempotencyKey: "refused", items: items("x", 1) }, headers: { "x-puppenclaw-principal": "run:a" } })).toMatchObject({ status: 409, body: { code: "PRINCIPAL_REQUIRED" } });
    // The variable stays an identifier the deployed sandbox wrappers expect, never authority.
    expect(runtime.environment("main").PUPPENCLAW_ORCHESTRATION_ATTEMPT_ID).toBe("attempt");
    const principalSocket = (await registry.put("run:a", runBody())).socketPath!;
    const job = await unix(principalSocket, "/bulk/submit", { body: { configId: "judge", idempotencyKey: "granted", items: items("p", 1) } });
    expect((await settledJob(runtime, job.body.jobId)).state).toBe("completed");
    expect(service.calls).toBe(1);
  });
});

describe("provider registry", () => {
  it("parses PUPPENCLAW_MODEL_PROVIDERS strictly and fails on duplicates or invalid entries", () => {
    expect(modelProvidersFromEnvironment({}).size).toBe(0);
    const providers = modelProvidersFromEnvironment({ PUPPENCLAW_MODEL_PROVIDERS: JSON.stringify([provider("judge", "http://127.0.0.1:1/v1")]) });
    expect([...providers.keys()]).toEqual(["judge"]);
    expect(() => modelProvidersFromEnvironment({ PUPPENCLAW_MODEL_PROVIDERS: "{" })).toThrow(/JSON array/);
    expect(() => modelProvidersFromEnvironment({ PUPPENCLAW_MODEL_PROVIDERS: JSON.stringify([{ id: "x" }]) })).toThrow(/JSON array/);
    expect(() => modelProvidersFromEnvironment({ PUPPENCLAW_MODEL_PROVIDERS: JSON.stringify([provider("a", "http://h/v1"), provider("a", "http://h/v1")]) })).toThrow(/twice/);
  });

  it("reports granted providers the daemon has no configuration for", async () => {
    const { registry } = await harness({ providers: [provider("judge", "http://127.0.0.1:9/v1")] });
    await registry.put("run:a", runBody({ socket: false }, { providers: ["judge", "missing"] }));
    expect(registry.detail("run:a")!.providersUnavailable).toEqual(["missing"]);
  });
});
