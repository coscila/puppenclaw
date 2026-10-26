import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AdvancedStore } from "../../src/advanced/store.js";
import type { BrokerJobPayload, BrokerReceiptPayload } from "../../src/advanced/outbox.js";
import type { UsageReceipt, WorkerJob } from "../../src/advanced/types.js";
import { AdvancedStore as LegacyStore } from "../fixtures/legacy/advanced-store-cea4c29.js";
import { createTempDir } from "../helpers.js";

/**
 * Rollback safety of the P1 schema: the store code of the H4 daemon (cea4c29,
 * same schema code as the deployed c36cfa2) opens, reads and writes a store that
 * P1 wrote, and P1 reopens what the older daemon left, catching the feed up.
 */
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function job(id: string, overrides: Partial<WorkerJob> = {}): WorkerJob {
  return {
    jobId: id, kind: "bulk", state: "running", parentSessionName: "parent", attemptId: "attempt", ownerKey: "owner-key-0123456789", configRevision: 1,
    config: { id: "refs", assignment: "Review", agent: "codex", modelProvider: { id: "local", model: "test", kind: "codex-openai-compatible" } },
    idempotencyKey: id, fingerprint: id, createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z",
    request: { configId: "refs", idempotencyKey: id, concurrency: 2, items: [{ id: "one", input: "first input" }, { id: "two", input: { messages: [{ role: "user", content: "second" }] } }] },
    results: ["one", "two"].map((item) => ({ id: item, state: "queued" as const, providerId: "local", model: "test", promptSha256: item, usage: null })),
    ...overrides
  };
}
function receipt(jobId: string, itemId: string): UsageReceipt {
  return { version: 1, requestId: `${jobId}-${itemId}`, parentSessionName: "parent", sessionName: "parent", attemptId: "attempt", jobId, itemId, providerId: "local", model: "served",
    role: "subagent", promptSha256: "a".repeat(64), state: "completed", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 2, quality: "measured" },
    createdAt: "2026-10-25T00:00:01.000Z", updatedAt: "2026-10-25T00:00:02.000Z", attempt: 1, serverFingerprint: "fp", settingsSha256: "s".repeat(64) };
}

describe("rollback safety of the P1 AdvancedStore", () => {
  it("keeps a job the older daemon wrote out of the archive, however old: its records reach Postgres only through the backfill", async () => {
    const dir = await createTempDir("advanced-legacy-archive-");
    const legacy = await LegacyStore.open(dir);
    legacy.putJob(job("historical", { state: "completed", updatedAt: "2026-08-25T00:00:00.000Z", results: ["one", "two"].map((item) => ({ id: item, state: "completed" as const, output: `answer ${item}`, providerId: "local", model: "served", promptSha256: item, usage: null })) }));
    legacy.putReceipt(receipt("historical", "one"));
    legacy.close();
    const p1 = await AdvancedStore.open(dir, { now: () => new Date("2026-10-25T00:00:00.000Z") });
    cleanups.push(() => p1.close());
    p1.ack(p1.feedId, p1.head());
    const report = await p1.archive({ before: new Date("2026-09-25T00:00:00.000Z") });
    expect(report).toMatchObject({ jobs: 0, file: null, skipped: { historical: 1 } });
    expect(p1.jobHeader("historical")).toMatchObject({ state: "completed" });
    expect(p1.jobReceipts("historical")).toHaveLength(1);
  });

  it("lets the cea4c29 store code open a store with a pending erasure, and P1 completes it afterwards", async () => {
    const dir = await createTempDir("advanced-legacy-erasure-");
    const p1 = await AdvancedStore.open(dir);
    p1.createJob(job("purged"));
    await p1.settleItem("purged", { id: "one", state: "completed", output: "answer", providerId: "local", model: "served", promptSha256: "a".repeat(64), usage: receipt("purged", "one").usage, attempts: 1 },
      { receipt: receipt("purged", "one"), event: true, persist: true, fallbackFingerprint: "x", fallbackSettingsSha256: "y", instrumentDigest: null });
    p1.purgeSession("parent");
    p1.close();
    const legacy = await LegacyStore.open(dir);
    expect(legacy.jobHeader("purged")).toBeNull();
    expect(legacy.receipts("parent").map((row) => row.requestId)).toEqual(["purged-one"]);
    legacy.close();
    const again = await AdvancedStore.open(dir);
    cleanups.push(() => again.close());
    expect(again.pendingErasures()).toEqual(["purged"]);
    again.ack(again.feedId, again.head());
    expect(again.pendingErasures()).toEqual([]);
    expect(again.receipts("parent")).toEqual([]);
  });


  it("lets the cea4c29 store code open, read and write a P1 store, and P1 reads what it wrote", async () => {
    const dir = await createTempDir("advanced-legacy-");
    // P1 writes: blob inputs, a settled item with receipt and outbox rows, an instrument, a deferred erasure.
    const p1 = await AdvancedStore.open(dir);
    p1.createJob(job("p1-job"));
    await p1.settleItem("p1-job", { id: "one", state: "completed", output: "answer", providerId: "local", model: "served", promptSha256: "a".repeat(64), usage: receipt("p1-job", "one").usage, attempts: 1 },
      { receipt: receipt("p1-job", "one"), event: true, persist: true, fallbackFingerprint: "x", fallbackSettingsSha256: "y", instrumentDigest: null });
    p1.putInstrument("digest-1", { instrumentId: "census@1" }, "settings");
    const feedId = p1.feedId, head = p1.head();
    p1.close();

    // The older daemon opens it unchanged and works on it.
    const legacy = await LegacyStore.open(dir);
    expect(legacy.jobHeader("p1-job")).toMatchObject({ jobId: "p1-job", state: "running" });
    expect(legacy.summaries("parent").jobs.map((entry) => [entry.job.jobId, entry.progress.completed, entry.progress.total])).toEqual([["p1-job", 1, 2]]);
    expect(legacy.resultPage("p1-job").results.map((result) => [result.id, result.state]).sort()).toEqual([["one", "completed"], ["two", "queued"]]);
    expect(legacy.receipts("parent").map((row) => row.requestId)).toEqual(["p1-job-one"]);
    expect(legacy.countJobsByState().running).toBe(1);
    // Inputs live in blobs the older code does not know: it sees no input, and nothing breaks.
    expect((legacy.job("p1-job")!.request as { items: { input: unknown }[] }).items.map((item) => item.input)).toEqual([null, null]);
    expect(legacy.recover()).toEqual([]);
    expect(legacy.jobHeader("p1-job")!.state).toBe("interrupted");
    legacy.putJob(job("legacy-job", { idempotencyKey: "legacy-key" }));
    legacy.updateItem("legacy-job", "one", { state: "completed", output: "legacy answer" });
    // Receipts of the older daemon carry no provenance digests.
    const { serverFingerprint: _fingerprint, settingsSha256: _settings, attempt: _attempt, ...legacyReceipt } = receipt("legacy-job", "one");
    legacy.putReceipt(legacyReceipt);
    legacy.close();

    // P1 again: the store opens, inline and blob inputs both hydrate, and the feed catches up on the older daemon's changes.
    const again = await AdvancedStore.open(dir);
    cleanups.push(() => again.close());
    expect(again.feedId).toBe(feedId);
    expect((again.job("p1-job")!.request as { items: { input: unknown }[] }).items.map((item) => item.input)).toEqual(["first input", { messages: [{ role: "user", content: "second" }] }]);
    expect((again.job("legacy-job")!.request as { items: { input: unknown }[] }).items.map((item) => item.input)).toEqual(["first input", { messages: [{ role: "user", content: "second" }] }]);
    expect(again.instrument("digest-1")?.settingsSha256).toBe("settings");
    const caughtUp = again.events(head, 100).events;
    expect(caughtUp.filter((event) => event.type === "broker.job").map((event) => [(event.payload as BrokerJobPayload).jobId, (event.payload as BrokerJobPayload).state]).sort())
      .toEqual([["legacy-job", "running"], ["p1-job", "interrupted"]]);
    const receipts = caughtUp.filter((event) => event.type === "broker.receipt").map((event) => event.payload as BrokerReceiptPayload);
    expect(receipts.map((payload) => [payload.jobId, payload.itemId, payload.status, payload.output])).toEqual([["legacy-job", "one", "succeeded", "legacy answer"]]);
    expect(receipts[0]!.serverFingerprint).not.toBe(""); expect(receipts[0]!.settingsSha256).toMatch(/^[0-9a-f]{64}$/u);
    // The older daemon rewrote the P1 job's header: it now counts as pre-P1, so recovery never requeues it.
    expect(again.storageVersion("p1-job")).toBe(1);
    expect(again.storageVersion("legacy-job")).toBe(1);
  });

  it("opens stores written by the older daemon and keeps their recovery semantics", async () => {
    const dir = await createTempDir("advanced-legacy-written-");
    const legacy = await LegacyStore.open(dir);
    legacy.putJob(job("old"));
    legacy.updateItem("old", "one", { state: "running" });
    legacy.putReceipt({ ...receipt("old", "one"), state: "running" });
    legacy.close();
    const store = await AdvancedStore.open(dir);
    cleanups.push(() => store.close());
    // History before P1 reaches Postgres through the backfill, so a first P1 open emits nothing for it.
    expect(store.events(0, 10).events).toEqual([]);
    store.recover();
    expect(store.job("old")!.results.map((result) => result.state)).toEqual(["interrupted", "interrupted"]);
    expect(store.lastRecovery.requeued).toEqual([]);
    expect(store.receipts("parent")[0]).toMatchObject({ state: "interrupted" });
    expect(store.ownedParents("owner-key-0123456789")).toEqual(["parent"]);
    const { DatabaseSync } = await import(`node${":sqlite"}`);
    const raw = new DatabaseSync(join(dir, "advanced.sqlite")); cleanups.push(() => raw.close());
    expect((raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('jobs_owner','jobs_child','jobs_state','receipts_owner','receipts_running') ORDER BY name").all() as { name: string }[]).map((row) => row.name))
      .toEqual(["jobs_child", "jobs_owner", "jobs_state", "receipts_owner", "receipts_running"]);
  });
});
