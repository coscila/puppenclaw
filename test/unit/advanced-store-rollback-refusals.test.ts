import { request } from "node:http";
import { connect } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { BrokerRefusalPayload } from "../../src/advanced/outbox.js";
import { AdvancedRuntime } from "../../src/advanced/runtime.js";
import type { UsageReceipt, WorkerJob } from "../../src/advanced/types.js";
import { startParamsZod } from "../../src/shared/schema.js";
import type { ModelProviderConfig, SessionInfo } from "../../src/shared/types.js";
import { AdvancedStore as Store5bc32a0 } from "../fixtures/legacy/advanced-store-5bc32a0.js";

/**
 * Rollback safety of broker.refusal events (brokerOutbox:3) against the store code of 5bc32a0, the daemon without
 * them. advanced.sqlite gains outbox rows of a new type, the refusal_erasure_pending table and the partial
 * outbox_refusal_session index; no column or existing row changes. The 5bc32a0 store code opens such a store, serves the
 * refusal rows through its feed like any event (an older lab skips their type), acknowledges and prunes them, and keeps
 * writing jobs and receipts beside them. After a roll forward this version finds its pending refusal erasures and the
 * outbox sequence as the older code left them.
 */
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); delete process.env.TEST_MODEL_KEY; });
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

function tunnel(socketPath: string, authority: string): Promise<void> {
  return new Promise((resolve) => {
    const client = connect(socketPath, () => client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    client.on("data", () => undefined);
    client.on("close", () => resolve());
    client.on("error", () => resolve());
    setTimeout(() => client.destroy(), 2_000).unref();
  });
}
function get(socketPath: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false, method: "GET" }, (res) => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
    req.once("error", reject); req.end();
  });
}

/** This version's broker over `root` with one chat turn, lab-chat-1. */
async function current(root: string) {
  process.env.TEST_MODEL_KEY = "test-secret";
  const runtime = await AdvancedRuntime.open(root, { defaultLimit: 4 });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await runtime.close(); };
  cleanups.push(close);
  const provider: ModelProviderConfig = { id: "local", model: "judge-model", kind: "codex-openai-compatible", baseUrl: "http://127.0.0.1:9/v1", authTokenEnv: "TEST_MODEL_KEY" };
  const params = startParamsZod.parse({ name: "lab-chat-1", agent: "codex", directory: "/tmp", task: "review", interactionMode: "execute", permissionMode: "approve-all",
    statisticsContext: { version: 1, chatId: "chat-1", attemptId: "attempt-1" }, modelProvider: provider,
    orchestration: { version: 1, revision: 1, workers: [{ id: "refs", assignment: "Check sources", agent: "codex", modelProvider: provider }] } });
  const session = { ...params, state: "idle", warnings: [], transcript: [], createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() } as unknown as SessionInfo;
  runtime.attach({ start: async () => ({ content: [], details: {} }), quiesce: async () => {}, getSession: () => session, contribution: () => {}, purge: async () => {} });
  await runtime.begin(session, params, "approve-all");
  return { runtime, socket: runtime.socket("lab-chat-1")!, close };
}

const refusal = (overrides: Partial<BrokerRefusalPayload>): BrokerRefusalPayload => ({
  sessionName: "lab-chat-1", attemptId: "attempt-1", principalId: null, jobId: null, kind: "egress", target: "10.0.0.9:443", code: "EGRESS_DENIED",
  at: "2026-11-06T10:00:00.000Z", repeats: 1, ...overrides
});

function sqlite(root: string): DatabaseSync {
  const db = new DatabaseSync(join(root, "advanced.sqlite"), { readOnly: true });
  cleanups.push(() => db.close());
  return db;
}

describe("rollback safety of broker.refusal events", () => {
  it("lets the 5bc32a0 store code open, serve, acknowledge and prune a store with refusal events and keep writing beside them", async () => {
    const root = join(await mkdtemp(join("/tmp", "pcrr-")), "advanced");
    const now = await current(root);
    // A denied tunnel (no job), a refusal concerning a job, and one of a session purged before the feed acknowledged it.
    await tunnel(now.socket, "10.0.0.1:443");
    for (let i = 0; i < 400 && now.runtime.store.events(0, 100).events.length === 0; i++) await delay(5);
    await now.runtime.store.recordRefusal(refusal({ jobId: "job-x", kind: "instrument", target: "e".repeat(64), code: "INSTRUMENT_MESSAGE_MISMATCH" }));
    await now.runtime.store.recordRefusal(refusal({ sessionName: "lab-chat-gone", attemptId: "attempt-9" }));
    now.runtime.store.purgeSession("lab-chat-gone");
    const written = now.runtime.store.events(0, 100).events;
    expect(written.map((event) => [event.type, event.jobId, (event.payload as BrokerRefusalPayload).sessionName])).toEqual([
      ["broker.refusal", "", "lab-chat-1"], ["broker.refusal", "job-x", "lab-chat-1"], ["broker.refusal", "", "lab-chat-gone"]
    ]);
    const head = now.runtime.store.head();
    await now.close();
    expect(sqlite(root).prepare("SELECT session FROM refusal_erasure_pending").all()).toEqual([{ session: "lab-chat-gone" }]);

    // The 5bc32a0 store code opens the store unchanged and serves the refusal rows like any event.
    const old = await Store5bc32a0.open(root);
    const served = old.events(0, 100);
    expect(served.events.map((event) => [event.seq, event.type, event.jobId])).toEqual(written.map((event) => [event.seq, event.type, event.jobId]));
    expect(served.events.map((event) => event.payload)).toEqual(written.map((event) => event.payload));
    // It keeps writing: a job and a settled item with its receipt, after the refusal rows in the sequence.
    const legacyJob: WorkerJob = {
      jobId: "legacy-job", kind: "bulk", state: "running", parentSessionName: "lab-chat-1", attemptId: "attempt-1", configRevision: 1,
      config: { id: "refs", assignment: "Review", agent: "codex", modelProvider: { id: "local", model: "judge-model", kind: "codex-openai-compatible" } },
      idempotencyKey: "legacy-job", fingerprint: "legacy-job", createdAt: "2026-11-06T10:00:00.000Z", updatedAt: "2026-11-06T10:00:00.000Z",
      request: { configId: "refs", idempotencyKey: "legacy-job", concurrency: 1, items: [{ id: "one", input: "x" }] },
      results: [{ id: "one", state: "queued", providerId: "local", model: "judge-model", promptSha256: "p", usage: null }]
    };
    const receipt: UsageReceipt = { version: 1, requestId: "legacy-request", parentSessionName: "lab-chat-1", sessionName: "lab-chat-1", attemptId: "attempt-1", jobId: "legacy-job", itemId: "one", providerId: "local", model: "judge-model",
      role: "subagent", promptSha256: "a".repeat(64), state: "completed", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 2, quality: "measured" }, createdAt: "2026-11-06T10:00:01.000Z", updatedAt: "2026-11-06T10:00:02.000Z", attempt: 1, serverFingerprint: "fp", settingsSha256: "s".repeat(64) };
    old.createJob(legacyJob);
    await old.settleItem("legacy-job", { id: "one", state: "completed", output: "T", providerId: "local", model: "judge-model", promptSha256: "a".repeat(64), usage: receipt.usage }, { receipt, event: true, persist: true, fallbackFingerprint: "fp", fallbackSettingsSha256: "s".repeat(64), instrumentDigest: null });
    const after = old.events(head, 100).events;
    expect(after.map((event) => event.type)).toEqual(expect.arrayContaining(["broker.job", "broker.receipt"]));
    expect(Math.min(...after.map((event) => event.seq))).toBeGreaterThan(head);
    // It acknowledges and prunes the refusal rows with the rest; the acknowledged ones go with retention.
    old.ack(old.feedId, head);
    expect(old.pruneAcknowledged(new Date(Date.now() + 60_000))).toBe(3);
    // Its event type knows no broker.refusal: what is left are its own job and receipt events.
    expect(old.events(0, 100).events.map((event) => event.type as string).filter((type) => type === "broker.refusal")).toEqual([]);
    expect(old.recover()).toEqual([]);
    old.close();

    // Rolled forward, this version completes the pending refusal erasure, keeps the sequence and records again.
    const again = await current(root);
    expect(sqlite(root).prepare("SELECT session FROM refusal_erasure_pending").all()).toEqual([]);
    expect(again.runtime.store.job("legacy-job")!.results[0]).toMatchObject({ state: "completed" });
    const before = again.runtime.store.head();
    expect(await get(again.socket, "http://10.0.0.2/x")).not.toBe(200);
    for (let i = 0; i < 400 && again.runtime.store.head() === before; i++) await delay(5);
    const [next] = again.runtime.store.events(before, 100).events;
    expect(next).toMatchObject({ type: "broker.refusal", payload: { sessionName: "lab-chat-1", target: "10.0.0.2:80", code: "EGRESS_DENIED" } });
    expect(next!.seq).toBeGreaterThan(Math.max(...after.map((event) => event.seq)));
  });
});
