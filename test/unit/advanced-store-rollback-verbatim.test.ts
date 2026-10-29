import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BulkResponseTransport } from "../../src/advanced/bulk-transport.js";
import { installedSettingsSha256, instrumentBundleZod, type InstrumentBundle } from "../../src/advanced/instruments.js";
import type { BrokerReceiptPayload } from "../../src/advanced/outbox.js";
import { PrincipalRegistry } from "../../src/advanced/principals.js";
import { AdvancedRuntime } from "../../src/advanced/runtime.js";
import type { UsageReceipt, WorkerJob } from "../../src/advanced/types.js";
import type { ModelProviderConfig } from "../../src/shared/types.js";
import { AdvancedStore as Store815463f } from "../fixtures/legacy/advanced-store-815463f.js";
import { AdvancedStore as StoreCea4c29 } from "../fixtures/legacy/advanced-store-cea4c29.js";
import { installedSettingsSha256 as installedSettings815463f, instrumentBundleZod as bundleZod815463f, instrumentCall as instrumentCall815463f } from "../fixtures/legacy/instruments-815463f.js";

/**
 * Rollback safety of verbatim instrument mode. Nothing changed in the store schema: verbatim bundles keep
 * `transport` in their bundle JSON, receipts, results and receipt events gain `requestSha256` inside their JSON.
 * The store code of the P1-P3 daemon (815463f) and of the H4 daemon (cea4c29) open, read and write such a store,
 * the P1-P3 daemon refuses a verbatim bundle instead of running it policy-wrapped, and bundles that daemon
 * installed stay valid here.
 */
const OWNER = "owner-key-0123456789abcdef";
const VERBATIM = "c".repeat(64);
const WRAPPED = "d".repeat(64);
const SYSTEM = "Judge every entry; one JSONL line each.\n";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); delete process.env.TEST_MODEL_KEY; });
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

const policyBundle: InstrumentBundle = {
  instrumentId: "citation-census@1", version: 1, systemPrompt: SYSTEM, responseSchema: null, maxOutputTokens: { perItem: 700, minimum: 3000 },
  temperature: 0, seed: null, reasoning: "none", itemsPerCall: 40, requiredModelFingerprint: null
};
const verbatimBundle: InstrumentBundle = { ...policyBundle, transport: { messages: "verbatim" } };
const verbatimInput = (user: string) => ({ model: "judge-model", messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }], max_tokens: 3000, temperature: 0, stream: false, reasoning_effort: "none", itemCount: 1 });

async function upstream(): Promise<{ url: string; bodies: Buffer[] }> {
  const bodies: Buffer[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
    bodies.push(Buffer.concat(chunks));
    res.writeHead(200, { "content-type": "application/json" });
    const chat = req.url?.endsWith("/chat/completions");
    res.end(JSON.stringify(chat
      ? { model: "judge-served", system_fingerprint: "fp_r", choices: [{ index: 0, message: { role: "assistant", content: "T" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } }
      : { model: "judge-served", status: "completed", output_text: "T", usage: { input_tokens: 9, output_tokens: 1 } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  return { url: `http://127.0.0.1:${address.port}/v1`, bodies };
}
function unix(socketPath: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false, method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.once("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.once("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** The current daemon's broker over a data directory, with one run principal granted both instruments. */
async function current(dataDir: string, baseUrl: string) {
  process.env.TEST_MODEL_KEY = "test-secret";
  const provider: ModelProviderConfig = { id: "judge", model: "judge-model", kind: "codex-openai-compatible", baseUrl, authTokenEnv: "TEST_MODEL_KEY" };
  const runtime = await AdvancedRuntime.open(join(dataDir, "advanced"), { defaultLimit: 8 }, { transport: new BulkResponseTransport(60_000, new Map()), retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 5 } });
  runtime.attach({ start: async () => ({ content: [], details: {} }), quiesce: async () => {}, getSession: () => null, contribution: () => {} });
  const registry = await PrincipalRegistry.open({ dataDir, runtime, providers: new Map([[provider.id, provider]]) });
  await runtime.recover();
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await registry.shutdown(); await runtime.close(); await registry.close(); };
  cleanups.push(close);
  const socket = async (instruments: string[]) => (await registry.put("run:census", { kind: "run", runId: "study-1", ownerKey: OWNER, grants: { providers: ["judge"], instruments, maxConcurrency: 4, maxItems: null, tokenBudget: null, expiresAt: null }, socket: true })).socketPath!;
  const settled = async (jobId: string) => {
    for (let i = 0; i < 400 && ["queued", "running"].includes(runtime.store.jobHeader(jobId)!.state); i++) await delay(5);
    await runtime.settled(jobId);
    return runtime.store.job(jobId)!;
  };
  return { runtime, registry, socket, settled, close };
}

describe("rollback safety of verbatim instrument mode", () => {
  it("lets the 815463f and cea4c29 store code open, read and write a store with verbatim instruments, jobs and requestSha256 receipts", async () => {
    const up = await upstream();
    const dataDir = await mkdtemp(join("/tmp", "pcpr-"));
    const root = join(dataDir, "advanced");
    const now = await current(dataDir, up.url);
    now.runtime.installInstrument(VERBATIM, verbatimBundle);
    now.runtime.installInstrument(WRAPPED, { ...policyBundle, transport: { messages: "policy-wrapped" } });
    const socket = await now.socket([VERBATIM, WRAPPED]);
    const verbatimJob = (await unix(socket, "/bulk/submit", { configId: "judge", idempotencyKey: "verbatim", instrumentDigest: VERBATIM, items: [{ id: "v1", input: verbatimInput("entry one") }, { id: "v2", input: verbatimInput("entry two") }] })).body;
    const wrappedJob = (await unix(socket, "/bulk/submit", { configId: "judge", idempotencyKey: "wrapped", instrumentDigest: WRAPPED, items: [{ id: "w1", input: "entry three" }] })).body;
    expect((await now.settled(verbatimJob.jobId)).state).toBe("completed");
    expect((await now.settled(wrappedJob.jobId)).state).toBe("completed");
    const written = now.runtime.store.job(verbatimJob.jobId)!;
    expect(written.results.every((result) => /^[0-9a-f]{64}$/u.test(result.requestSha256 ?? ""))).toBe(true);
    const head = now.runtime.store.head();
    const wrappedSettings = now.runtime.instruments().find((record) => record.digest === WRAPPED)!.settingsSha256;
    await now.close();

    // The P1-P3 daemon's store code opens the store unchanged and reads every record, requestSha256 included.
    const p3 = await Store815463f.open(root);
    const instruments = new Map(p3.instruments().map((record) => [record.digest, record]));
    expect([...instruments.keys()].sort()).toEqual([VERBATIM, WRAPPED]);
    // Its strict bundle schema reads the policy-wrapped bundle (stored without transport) and digests it as this version does ...
    const wrapped = bundleZod815463f.parse(instruments.get(WRAPPED)!.bundle);
    expect(installedSettings815463f("POLICY", wrapped)).toBe(installedSettingsSha256("POLICY", instrumentBundleZod.parse(instruments.get(WRAPPED)!.bundle)));
    expect(instruments.get(WRAPPED)!.settingsSha256).toBe(wrappedSettings);
    // ... and refuses the verbatim one, so after a rollback a verbatim instrument fails closed instead of running policy-wrapped.
    const refused = bundleZod815463f.safeParse(instruments.get(VERBATIM)!.bundle);
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused.error?.issues)).toContain("transport");
    // Its item schema refuses a verbatim item as well: the system message is not an instrument item there.
    expect(() => instrumentCall815463f(wrapped, verbatimInput("x"))).toThrow();
    const readBack = p3.job(verbatimJob.jobId)!;
    expect((readBack.request as { items: { input: unknown }[] }).items.map((entry) => entry.input)).toEqual([verbatimInput("entry one"), verbatimInput("entry two")]);
    expect(readBack.results.map((result) => [result.id, result.state, result.requestSha256])).toEqual(written.results.map((result) => [result.id, "completed", result.requestSha256]));
    expect(p3.receipts("principal:run:census").filter((receipt) => receipt.jobId === verbatimJob.jobId).map((receipt) => receipt.requestSha256).sort()).toEqual(written.results.map((result) => result.requestSha256).sort());
    const events = p3.events(0, 100).events.filter((event) => event.type === "broker.receipt");
    expect(events.map((event) => (event.payload as BrokerReceiptPayload).requestSha256).filter(Boolean)).toHaveLength(3);
    expect(p3.recover()).toEqual([]);
    // It keeps writing: a job and a settled item with a receipt of its own (no requestSha256).
    const legacyJob: WorkerJob = {
      jobId: "legacy-job", kind: "bulk", state: "running", parentSessionName: "parent", attemptId: "attempt", configRevision: 1,
      config: { id: "judge", assignment: "Review", agent: "codex", modelProvider: { id: "judge", model: "judge-model", kind: "codex-openai-compatible" } },
      idempotencyKey: "legacy-job", fingerprint: "legacy-job", createdAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z",
      request: { configId: "judge", idempotencyKey: "legacy-job", concurrency: 1, items: [{ id: "one", input: "x" }] },
      results: [{ id: "one", state: "queued", providerId: "judge", model: "judge-model", promptSha256: "p", usage: null }]
    };
    const legacyReceipt: UsageReceipt = { version: 1, requestId: "legacy-request", parentSessionName: "parent", sessionName: "parent", attemptId: "attempt", jobId: "legacy-job", itemId: "one", providerId: "judge", model: "judge-served",
      role: "subagent", promptSha256: "a".repeat(64), state: "completed", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 2, quality: "measured" }, createdAt: "2026-10-26T00:00:01.000Z", updatedAt: "2026-10-26T00:00:02.000Z", attempt: 1, serverFingerprint: "fp", settingsSha256: "s".repeat(64) };
    p3.createJob(legacyJob);
    await p3.settleItem("legacy-job", { id: "one", state: "completed", output: "T", providerId: "judge", model: "judge-served", promptSha256: "a".repeat(64), usage: legacyReceipt.usage }, { receipt: legacyReceipt, event: true, persist: true, fallbackFingerprint: "fp", fallbackSettingsSha256: "s".repeat(64), instrumentDigest: null });
    p3.close();

    // The H4 daemon's store code opens it too.
    const h4 = await StoreCea4c29.open(root);
    expect(h4.jobHeader(verbatimJob.jobId)).toMatchObject({ state: "completed", principalId: "run:census", request: { instrumentDigest: VERBATIM } });
    expect(h4.resultPage(verbatimJob.jobId).results.map((result) => result.requestSha256)).toEqual(written.results.map((result) => result.requestSha256));
    expect(h4.receipts("principal:run:census").length).toBeGreaterThanOrEqual(3);
    expect(h4.summaries().jobs.map((entry) => entry.job.jobId).sort()).toEqual(["legacy-job", verbatimJob.jobId, wrappedJob.jobId].sort());
    h4.close();

    // Rolled forward again, this version finds both instruments as it left them and the events the older code wrote.
    const again = await current(dataDir, up.url);
    expect(again.runtime.instruments().map((record) => [record.digest, record.bundle.transport ?? null]).sort()).toEqual([[VERBATIM, { messages: "verbatim" }], [WRAPPED, null]]);
    expect(again.runtime.installInstrument(VERBATIM, verbatimBundle).settingsSha256).toBe(instruments.get(VERBATIM)!.settingsSha256);
    expect(again.runtime.store.events(head, 100).events.map((event) => [event.type, event.jobId])).toEqual(expect.arrayContaining([["broker.job", "legacy-job"], ["broker.receipt", "legacy-job"]]));
    expect(again.runtime.store.job("legacy-job")!.results[0]).toMatchObject({ state: "completed" });
  });

  it("keeps a bundle the 815463f daemon installed valid: policy-wrapped, idempotent under a repeated or spelled-out PUT, and runnable", async () => {
    const up = await upstream();
    const dataDir = await mkdtemp(join("/tmp", "pcpr-"));
    const old = await Store815463f.open(join(dataDir, "advanced"));
    const parsed = bundleZod815463f.parse(policyBundle);
    const installed = old.putInstrument(WRAPPED, parsed, installedSettings815463f("POLICY", parsed));
    old.close();

    const now = await current(dataDir, up.url);
    expect(instrumentBundleZod.parse(now.runtime.instruments()[0]!.bundle)).toEqual(policyBundle);
    for (const body of [policyBundle, { ...policyBundle, transport: { messages: "policy-wrapped" } }]) {
      expect(now.runtime.installInstrument(WRAPPED, body)).toMatchObject({ digest: WRAPPED, settingsSha256: installed.settingsSha256, installedAt: installed.installedAt });
    }
    expect(() => now.runtime.installInstrument(WRAPPED, verbatimBundle)).toThrow(expect.objectContaining({ code: "INSTRUMENT_DIGEST_CONFLICT" }));
    const socket = await now.socket([WRAPPED]);
    const job = (await unix(socket, "/bulk/submit", { configId: "judge", idempotencyKey: "old-bundle", instrumentDigest: WRAPPED, items: [{ id: "a", input: { messages: [{ role: "user", content: "entry" }], itemCount: 1 } }] })).body;
    const done = await now.settled(job.jobId);
    expect(done.results[0]).toMatchObject({ state: "completed", output: "T" });
    const sent = JSON.parse(up.bodies[0]!.toString()) as { input: { role: string; content: string }[] };
    expect(sent.input[0]!.content.endsWith(`\n\n${SYSTEM}`)).toBe(true);
    expect(done.results[0]!.requestSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(done.results[0]!.promptSha256).toBe(sha256(up.bodies[0]!));
  });
});
