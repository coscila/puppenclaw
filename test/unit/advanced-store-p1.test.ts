import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { AdvancedStore, FeedCursorError, P1_STORAGE_VERSION, type AdvancedStoreOptions } from "../../src/advanced/store.js";
import { BROKER_JOB_EVENT, BROKER_RECEIPT_EVENT, type BrokerJobPayload, type BrokerReceiptPayload } from "../../src/advanced/outbox.js";
import type { ItemResult, UsageReceipt, WorkerJob } from "../../src/advanced/types.js";
import { createTempDir } from "../helpers.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function open(dir?: string, options: AdvancedStoreOptions = {}): Promise<{ store: AdvancedStore; dir: string; db: () => DatabaseSync }> {
  const root = dir ?? await createTempDir("advanced-p1-");
  let connection: DatabaseSync | undefined;
  const store = await AdvancedStore.open(root, { ...options, onConnection: (db) => { connection = db; options.onConnection?.(db); } });
  cleanups.push(() => store.close());
  return { store, dir: root, db: () => connection! };
}

function job(id: string, items: string[], overrides: Partial<WorkerJob> = {}, inputs: (index: number) => string = (index) => `INPUT ${index}`): WorkerJob {
  return {
    jobId: id, kind: "bulk", state: "running", parentSessionName: "parent", attemptId: "attempt", ownerKey: "owner-key-0123456789", configRevision: 1,
    config: { id: "refs", assignment: "Review", agent: "codex", modelProvider: { id: "local", model: "test", kind: "codex-openai-compatible" } },
    idempotencyKey: id, fingerprint: id, createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z",
    request: { configId: "refs", idempotencyKey: id, concurrency: 2, items: items.map((item, index) => ({ id: item, input: inputs(index) })) },
    results: items.map((item) => ({ id: item, state: "queued", providerId: "local", model: "test", promptSha256: item, usage: null })),
    ...overrides
  };
}

function receipt(jobId: string, itemId: string, requestId = `${jobId}-${itemId}`): UsageReceipt {
  return {
    version: 1, requestId, parentSessionName: "parent", sessionName: "parent", attemptId: "attempt", jobId, itemId, ownerKey: "owner-key-0123456789",
    providerId: "local", model: "served-model", role: "subagent", promptSha256: "a".repeat(64), state: "completed",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 12, quality: "measured" },
    createdAt: "2026-10-25T00:00:01.000Z", updatedAt: "2026-10-25T00:00:02.000Z", attempt: 1,
    serverFingerprint: "fp_test", settingsSha256: "b".repeat(64)
  };
}

function settled(itemId: string, output: unknown = `answer ${itemId}`): ItemResult {
  return { id: itemId, state: "completed", output, providerId: "local", model: "served-model", promptSha256: "a".repeat(64), usage: receipt("j", itemId).usage, attempts: 1 };
}

const settlement = (jobId: string, itemId: string) => ({ receipt: receipt(jobId, itemId), event: true, persist: true, fallbackFingerprint: "unused", fallbackSettingsSha256: "unused", instrumentDigest: null });
const count = (db: DatabaseSync, sql: string, ...params: (string | number)[]) => Number((db.prepare(sql).get(...params) as { n: number }).n);

describe("P1 AdvancedStore group commit", () => {
  it("commits a burst of writes as one transaction, within the window, and only then", async () => {
    const { store, dir } = await open(undefined, { commitWindowMs: 50 });
    store.createJob(job("j", Array.from({ length: 200 }, (_, index) => `i${index}`)));
    const before = store.stats.batches;
    for (let index = 0; index < 200; index += 1) void store.settleItem("j", settled(`i${index}`), settlement("j", `i${index}`));
    // A second connection sees nothing until the window closes: nothing is written per item.
    const { DatabaseSync } = await import(`node${":sqlite"}`);
    const reader = new DatabaseSync(join(dir, "advanced.sqlite")); cleanups.push(() => reader.close());
    expect(count(reader, "SELECT count(*) AS n FROM receipts")).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(store.pendingWrites()).toBe(0);
    expect(store.stats.batches - before).toBe(1);
    expect(count(reader, "SELECT count(*) AS n FROM receipts")).toBe(200);
    expect(count(reader, "SELECT count(*) AS n FROM outbox WHERE type='broker.receipt'")).toBe(200);
    expect(count(reader, "SELECT count(*) AS n FROM job_items WHERE state='completed'")).toBe(200);
  });

  it("replays a failing batch write by write so only the failing write is lost", async () => {
    const { store } = await open();
    store.createJob(job("a", ["x"]));
    const writes = [store.settleItem("a", settled("x"), settlement("a", "x")), store.putJob(job("b", ["y"], { idempotencyKey: "a" })), store.putJob(job("c", ["z"]))];
    store.flush();
    const outcomes = await Promise.allSettled(writes);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(store.stats).toMatchObject({ fallbacks: 1, failedMutations: 1 });
    expect(store.item("a", "x")?.state).toBe("completed");
    expect(store.jobHeader("b")).toBeNull();
    expect(store.jobHeader("c")?.jobId).toBe("c");
  });

  it("lets every read see pending writes and keeps running state in memory only", async () => {
    const { store, db } = await open(undefined, { commitWindowMs: 50 });
    store.createJob(job("j", ["one", "two"]));
    const revision = count(db(), "SELECT value AS n FROM change_sequence");
    store.markRunning("j", store.item("j", "one")!);
    expect(store.item("j", "one")?.state).toBe("running");
    expect(store.progress("j")).toMatchObject({ total: 2, queued: 1, running: 1 });
    expect(store.job("j")!.results.map((result) => result.state)).toEqual(["running", "queued"]);
    expect(store.job("j", { overlay: false })!.results.map((result) => result.state)).toEqual(["queued", "queued"]);
    expect(count(db(), "SELECT value AS n FROM change_sequence")).toBe(revision);
    void store.settleItem("j", settled("one"), settlement("j", "one"));
    expect(store.pendingWrites()).toBe(1);
    expect(store.item("j", "one")?.state).toBe("completed");
    expect(store.pendingWrites()).toBe(0);
    expect(store.progress("j")).toMatchObject({ completed: 1, queued: 1, running: 0 });
  });

  it("settles an item, its receipt and its outbox row in one write and refuses a duplicate completion", async () => {
    const { store, db } = await open();
    store.createJob(job("j", ["one"]));
    const first = store.settleItem("j", settled("one"), settlement("j", "one"));
    const second = store.settleItem("j", settled("one", "second answer"), { ...settlement("j", "one"), receipt: receipt("j", "one", "another-request") });
    store.flush();
    await Promise.all([first, second]);
    expect(store.item("j", "one")?.output).toBe("answer one");
    expect(store.jobReceipts("j").map((row) => row.requestId)).toEqual(["j-one"]);
    expect(count(db(), "SELECT count(*) AS n FROM outbox WHERE type='broker.receipt'")).toBe(1);
    expect(store.stats.duplicateSettlements).toBe(1);
  });

  it("rewrites a job header at most once a second while its items settle", async () => {
    const { store, db } = await open(undefined, { commitWindowMs: 0 });
    store.createJob(job("j", Array.from({ length: 60 }, (_, index) => `i${index}`)));
    db().exec("CREATE TEMP TABLE header_writes (n INTEGER); INSERT INTO header_writes VALUES (0); CREATE TEMP TRIGGER count_header AFTER UPDATE OF payload ON jobs BEGIN UPDATE header_writes SET n=n+1; END;");
    const cursor = store.summaries().nextCursor;
    for (let index = 0; index < 60; index += 1) await store.settleItem("j", settled(`i${index}`), settlement("j", `i${index}`));
    // 60 single-item batches, yet the payload was rewritten at most once; progress still moves the summary cursor.
    expect(count(db(), "SELECT n FROM header_writes")).toBeLessThanOrEqual(1);
    const changed = store.summaries("parent", { after: cursor });
    expect(changed.jobs.map((entry) => [entry.job.jobId, entry.progress.completed])).toEqual([["j", 60]]);
  });

  it("stores item inputs once per digest and keeps them out of the item rows", async () => {
    const { store, db } = await open();
    store.createJob(job("j", Array.from({ length: 100 }, (_, index) => `i${index}`), {}, (index) => `SHARED INPUT ${index % 10}`));
    store.createJob(job("resume", Array.from({ length: 100 }, (_, index) => `i${index}`), { resumedFromJobId: "j" }, (index) => `SHARED INPUT ${index % 10}`));
    expect(count(db(), "SELECT count(*) AS n FROM blobs")).toBe(10);
    expect(count(db(), "SELECT count(*) AS n FROM item_inputs")).toBe(200);
    expect(count(db(), "SELECT count(*) AS n FROM job_items WHERE input IS NOT NULL")).toBe(0);
    expect((store.job("j")!.request as { items: { input: unknown }[] }).items[13]!.input).toBe("SHARED INPUT 3");
    expect(store.storageVersion("j")).toBe(P1_STORAGE_VERSION);
    store.ack(store.feedId, store.head());
    store.purgeSession("parent");
    expect(count(db(), "SELECT count(*) AS n FROM blobs")).toBe(0);
  });

  it("answers owner, child and state lookups from indexes instead of full scans", async () => {
    const { store, db } = await open();
    store.createJob(job("j", ["one"]));
    const plan = (sql: string, ...params: string[]) => (db().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((row) => row.detail).join(" | ");
    expect(plan("SELECT parent FROM jobs WHERE json_extract(payload,'$.ownerKey')=? UNION SELECT parent FROM receipts WHERE json_extract(payload,'$.ownerKey')=?", "o", "o")).toMatch(/USING INDEX jobs_owner.*USING INDEX receipts_owner/u);
    expect(plan("SELECT id FROM jobs WHERE parent=? UNION SELECT id FROM jobs WHERE json_extract(payload,'$.childSessionName')=?", "p", "c")).toMatch(/USING (COVERING )?INDEX .*jobs_child/u);
    expect(plan("SELECT payload FROM jobs WHERE json_extract(payload,'$.state') IN ('queued','running')")).toMatch(/USING INDEX jobs_state/u);
    expect(plan("SELECT payload FROM receipts WHERE json_extract(payload,'$.state')='running'")).toMatch(/USING INDEX receipts_running/u);
    expect(store.ownedParents("owner-key-0123456789")).toEqual(["parent"]);
  });
});

describe("P1 broker outbox and feed", () => {
  it("writes broker.job on creation and state changes and broker.receipt per settled item, in the contract shape", async () => {
    const { store } = await open();
    store.createJob(job("j", ["one", "two", "three"], { state: "queued" }));
    store.updateHeader("j", { state: "running" });
    await store.settleItem("j", { ...settled("one"), truncated: true, finishReason: "length" }, settlement("j", "one"));
    await store.settleItem("j", { ...settled("two"), state: "failed", errorCode: "PROVIDER_UNREACHABLE", error: "x" }, settlement("j", "two"));
    store.updateHeader("j", { state: "failed" });
    const page = store.events(0, 100);
    expect(page.events.map((event) => [event.seq, event.type, event.itemId ?? null])).toEqual([
      [1, BROKER_JOB_EVENT, null], [2, BROKER_JOB_EVENT, null], [3, BROKER_RECEIPT_EVENT, "one"], [4, BROKER_RECEIPT_EVENT, "two"], [5, BROKER_JOB_EVENT, null]
    ]);
    const last = page.events[4]!.payload as BrokerJobPayload;
    // The pcp/2 fields plus three link hints (parentSessionName, attemptId and, from brokerOutbox:2, resumedFromJobId).
    expect(Object.keys(last).sort()).toEqual(["attemptId", "counts", "createdAt", "instrumentDigest", "jobId", "ownerKey", "parentSessionName", "principalId", "resumedFromJobId", "runId", "state", "updatedAt"]);
    expect(last).toMatchObject({ jobId: "j", ownerKey: "owner-key-0123456789", principalId: null, runId: null, state: "failed", instrumentDigest: null, parentSessionName: "parent", attemptId: "attempt", resumedFromJobId: null,
      counts: { total: 3, queued: 1, running: 0, succeeded: 0, failed: 1, cancelled: 0, truncated: 1 } });
    const truncated = page.events[2]!.payload as BrokerReceiptPayload;
    expect(Object.keys(truncated).sort()).toEqual(["attempt", "endedAt", "error", "finishReason", "httpStatus", "instrumentDigest", "itemId", "jobId", "model", "output", "outputBytes", "outputDigest", "requestSha256", "servedModel", "serverFingerprint", "settingsSha256", "startedAt", "status", "systemFingerprint", "usage"]);
    // brokerOutbox:2: what the upstream answered; this item recorded none and its receipt no HTTP status.
    expect(truncated).toMatchObject({ servedModel: null, systemFingerprint: null, httpStatus: null });
    expect(truncated).toMatchObject({ jobId: "j", itemId: "one", attempt: 1, status: "truncated", finishReason: "length", model: "served-model", serverFingerprint: "fp_test",
      settingsSha256: "b".repeat(64), requestSha256: null, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }, output: "answer one", outputBytes: 10, error: null,
      startedAt: "2026-10-25T00:00:01.000Z", endedAt: "2026-10-25T00:00:02.000Z" });
    expect(truncated.outputDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect((page.events[3]!.payload as BrokerReceiptPayload)).toMatchObject({ status: "failed", error: { code: "PROVIDER_UNREACHABLE", retryable: true } });
  });

  it("names the outbox columns as the pcp/2 contract does and renames those of a pre-release store", async () => {
    const contract = ["seq", "type", "jobId", "itemId", "payload", "createdAt"];
    const fresh = await open();
    const names = (db: DatabaseSync) => (db.prepare("PRAGMA table_info(outbox)").all() as { name: string }[]).map((column) => column.name);
    expect(names(fresh.db())).toEqual(expect.arrayContaining(contract));
    // A store written by a pre-release build of P1 named them job_id, item_id and created_at.
    const dir = await createTempDir("advanced-p1-outbox-");
    const { DatabaseSync } = await import(`node${":sqlite"}`);
    const legacy = new DatabaseSync(join(dir, "advanced.sqlite"));
    legacy.exec("CREATE TABLE outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, job_id TEXT NOT NULL, item_id TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL, receipt_id TEXT); CREATE INDEX outbox_job ON outbox(job_id,seq)");
    legacy.prepare("INSERT INTO outbox (type, job_id, item_id, payload, created_at) VALUES (?,?,?,?,?)").run(BROKER_JOB_EVENT, "old", null, JSON.stringify({ jobId: "old", state: "queued" }), "2026-10-25T00:00:00.000Z");
    legacy.close();
    const reopened = await open(dir);
    expect(names(reopened.db())).toEqual(expect.arrayContaining([...contract, "receiptId"]));
    expect(names(reopened.db())).not.toContain("job_id");
    expect(reopened.store.events(0, 10).events).toEqual([expect.objectContaining({ seq: 1, type: BROKER_JOB_EVENT, jobId: "old", at: "2026-10-25T00:00:00.000Z" })]);
  });

  it("carries outputs up to 16 KiB inline and only their digest above", async () => {
    const { store } = await open();
    store.createJob(job("j", ["small", "large"]));
    await store.settleItem("j", settled("small", "x".repeat(16_384)), settlement("j", "small"));
    await store.settleItem("j", settled("large", "x".repeat(16_385)), settlement("j", "large"));
    const [small, large] = store.events(1, 10).events.map((event) => event.payload as BrokerReceiptPayload);
    expect(small).toMatchObject({ outputBytes: 16_384, output: "x".repeat(16_384) });
    expect(large).toMatchObject({ outputBytes: 16_385 }); expect(large).not.toHaveProperty("output");
  });

  it("pages in seq order, refuses a cursor beyond the head and acknowledges durably without moving backwards", async () => {
    const { store, dir } = await open();
    for (let index = 0; index < 5; index += 1) store.createJob(job(`j${index}`, ["one"], { idempotencyKey: `k${index}` }));
    const first = store.events(0, 2);
    expect(first).toMatchObject({ next: 2, hasMore: true, head: 5, acked: 0 });
    expect(store.events(first.next, 10).events.map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(store.events(5, 10)).toMatchObject({ events: [], next: 5, hasMore: false });
    expect(() => store.events(6, 10)).toThrow(FeedCursorError);
    expect(() => store.ack("another-feed", 1)).toThrow(expect.objectContaining({ code: "FEED_REPLACED" }));
    expect(() => store.ack(store.feedId, 6)).toThrow(expect.objectContaining({ code: "INVALID_EVENT_CURSOR" }));
    expect(store.ack(store.feedId, 3)).toBe(3);
    expect(store.ack(store.feedId, 1)).toBe(3);
    const feedId = store.feedId; store.close();
    const reopened = await open(dir);
    expect(reopened.store.feedId).toBe(feedId);
    expect(reopened.store.acked).toBe(3);
    expect(reopened.store.events(0, 10).acked).toBe(3);
    const replaced = await open();
    expect(replaced.store.feedId).not.toBe(feedId);
  });

  it("wakes a long poll when an event commits and returns at once when one exists", async () => {
    const { store } = await open(undefined, { commitWindowMs: 20 });
    const started = Date.now();
    const waiting = store.waitForEvents(0, 5_000);
    setTimeout(() => { store.createJob(job("j", ["one"])); }, 30);
    await waiting;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(store.events(0, 10).events).toHaveLength(1);
    const immediate = Date.now(); await store.waitForEvents(0, 5_000); expect(Date.now() - immediate).toBeLessThan(100);
    const timedOut = Date.now(); await store.waitForEvents(1, 50); expect(Date.now() - timedOut).toBeGreaterThanOrEqual(45);
  });

  it("never prunes unacknowledged events and prunes acknowledged ones only past the cutoff", async () => {
    let now = new Date("2026-10-01T00:00:00.000Z");
    const { store } = await open(undefined, { now: () => now });
    for (let index = 0; index < 4; index += 1) store.createJob(job(`j${index}`, ["one"], { idempotencyKey: `k${index}` }));
    now = new Date("2026-10-20T00:00:00.000Z");
    expect(store.pruneAcknowledged(new Date("2026-10-13T00:00:00.000Z"))).toBe(0);
    store.ack(store.feedId, 2);
    expect(store.pruneAcknowledged(new Date("2026-10-13T00:00:00.000Z"))).toBe(2);
    expect(store.events(0, 10).events.map((event) => event.seq)).toEqual([3, 4]);
    store.createJob(job("j9", ["one"], { idempotencyKey: "k9" }));
    expect(store.head()).toBe(5);
  });

  it("erases the contents of a purged job with unacknowledged events at once and its receipts on the acknowledgement", async () => {
    const { store, db } = await open();
    store.createJob(job("j", ["one", "two"], {}, (index) => `CONFIDENTIAL INPUT ${index}`));
    await store.settleItem("j", settled("one", "CONFIDENTIAL OUTPUT"), settlement("j", "one"));
    store.ack(store.feedId, 1);
    store.putReceipt({ ...receipt("controller", "none", "controller-call"), jobId: undefined as never, itemId: undefined as never });
    store.purgeSession("parent");
    expect(store.pendingErasures()).toEqual(["j"]);
    expect(store.pendingErasures({ owner: "owner-key-0123456789" })).toEqual(["j"]);
    expect(store.pendingErasures({ session: "parent" })).toEqual(["j"]);
    expect(store.pendingErasureCount).toBe(1);
    // Contents are gone now: the job row, its items, inputs and blobs, and its acknowledged events.
    expect(store.jobHeader("j")).toBeNull();
    for (const table of ["jobs", "job_items", "item_inputs", "blobs"]) expect(count(db(), `SELECT count(*) AS n FROM ${table}`)).toBe(0);
    expect(store.ownedParents("owner-key-0123456789")).toEqual(["parent"]);
    // What the feed still needs stays: the receipt row and the unacknowledged receipt event, without its inline output.
    expect(store.receipts("parent").map((row) => row.requestId)).toEqual(["j-one"]);
    const pending = store.events(0, 10).events;
    expect(pending.map((event) => [event.seq, event.type])).toEqual([[2, BROKER_RECEIPT_EVENT]]);
    expect(pending[0]!.payload).not.toHaveProperty("output");
    expect(pending[0]!.payload).toMatchObject({ itemId: "one", outputBytes: Buffer.byteLength("CONFIDENTIAL OUTPUT") });
    expect(JSON.stringify(db().prepare("SELECT * FROM outbox").all())).not.toContain("CONFIDENTIAL");
    // Purging again changes nothing; the acknowledgement completes the erasure.
    store.purgeSession("parent");
    expect(store.receipts("parent")).toHaveLength(1);
    store.ack(store.feedId, store.head());
    expect(store.pendingErasures()).toEqual([]);
    expect(store.pendingErasureCount).toBe(0);
    expect(count(db(), "SELECT count(*) AS n FROM receipts")).toBe(0);
    expect(count(db(), "SELECT count(*) AS n FROM outbox")).toBe(0);
    expect(store.ownedParents("owner-key-0123456789")).toEqual([]);
  });

  it("keeps a pending erasure across a reopen and completes it when the acknowledgement arrives later", async () => {
    const first = await open();
    first.store.createJob(job("j", ["one"]));
    await first.store.settleItem("j", settled("one"), settlement("j", "one"));
    first.store.purgeSession("parent");
    first.store.close();
    const { store, db } = await open(first.dir);
    expect(store.pendingErasures()).toEqual(["j"]);
    expect(store.pendingErasureCount).toBe(1);
    expect(store.jobHeader("j")).toBeNull();
    store.ack(store.feedId, store.head());
    expect(store.pendingErasures()).toEqual([]);
    expect(count(db(), "SELECT count(*) AS n FROM receipts")).toBe(0);
  });

  it("converts the deferred whole jobs of a pre-release store into pending erasures without their contents", async () => {
    const first = await open();
    first.store.createJob(job("j", ["one"], {}, () => "CONFIDENTIAL INPUT"));
    await first.store.settleItem("j", settled("one", "CONFIDENTIAL OUTPUT"), settlement("j", "one"));
    first.store.flush();
    // A pre-release build kept a purged job whole in purge_deferred until the acknowledgement.
    first.db().exec("CREATE TABLE purge_deferred (job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, requested_at TEXT NOT NULL) WITHOUT ROWID; INSERT INTO purge_deferred VALUES ('j', '2026-10-25T00:00:00.000Z')");
    first.store.close();
    const { store, db } = await open(first.dir);
    expect(store.pendingErasures({ owner: "owner-key-0123456789" })).toEqual(["j"]);
    expect(store.jobHeader("j")).toBeNull();
    expect(count(db(), "SELECT count(*) AS n FROM sqlite_master WHERE name='purge_deferred'")).toBe(0);
    expect(JSON.stringify([...db().prepare("SELECT * FROM outbox").all(), ...db().prepare("SELECT * FROM blobs").all()])).not.toContain("CONFIDENTIAL");
    store.ack(store.feedId, store.head());
    expect(store.pendingErasures()).toEqual([]);
  });

  it("requeues the unsettled items of P1 bulk jobs and relaunches only jobs whose authority survives", async () => {
    const { store, dir } = await open();
    store.createJob(job("kept", ["one", "two"]));
    store.createJob(job("relaunched", ["one", "two"], { idempotencyKey: "k2", principalId: "run:study" }));
    await store.settleItem("kept", settled("one"), settlement("kept", "one"));
    store.close();
    const reopened = (await open(dir)).store;
    expect(reopened.recover({ relaunch: (header) => header.principalId === "run:study" })).toEqual([]);
    expect(reopened.lastRecovery).toEqual({ requeued: ["kept", "relaunched"], relaunch: ["relaunched"] });
    expect(reopened.job("kept")).toMatchObject({ state: "interrupted", error: expect.stringContaining("resume") as string });
    expect(reopened.job("kept")!.results.map((result) => result.state)).toEqual(["completed", "queued"]);
    expect(reopened.job("relaunched")!.state).toBe("queued");
    const states = reopened.events(0, 100).events.filter((event) => event.type === BROKER_JOB_EVENT).map((event) => [(event.payload as BrokerJobPayload).jobId, (event.payload as BrokerJobPayload).state]);
    expect(states).toContainEqual(["kept", "interrupted"]);
  });

  it("archives verified terminal P1 jobs on request and keeps run, study, historical, unacknowledged and recent ones", async () => {
    let now = new Date("2026-08-01T00:00:00.000Z");
    const { store, dir, db } = await open(undefined, { now: () => now });
    const ids = ["old", "study", "unacked", "recent", "run", "historical"];
    for (const id of ids) store.createJob(job(id, ["one", "two"], { idempotencyKey: id, state: "completed", updatedAt: id === "recent" ? "2026-10-20T00:00:00.000Z" : "2026-08-01T00:00:00.000Z", ...(id === "run" ? { parentSessionName: "principal:run:census", principalId: "run:census", runId: "census" } : {}) }));
    for (const id of ids) await store.settleItem(id, settled("one"), settlement(id, "one"));
    store.ack(store.feedId, store.head());
    store.updateHeader("unacked", { state: "completed", updatedAt: "2026-08-01T00:00:00.000Z" });
    store.updateHeader("unacked", { state: "failed", updatedAt: "2026-08-01T00:00:00.000Z" });
    store.setStudyRef("study", "study:census-reproduction");
    // A job written before P1: its records reach Postgres only through the backfill, which the daemon cannot see.
    db().exec("UPDATE jobs SET storage_version=1 WHERE id='historical'");
    now = new Date("2026-10-25T00:00:00.000Z");
    const report = await store.archive({ before: new Date("2026-09-25T00:00:00.000Z") });
    expect(report).toMatchObject({ jobs: 1, items: 2, receipts: 1, skipped: { studyRef: 1, run: 1, historical: 1, unacknowledged: 1 } });
    expect(store.jobHeader("old")).toBeNull();
    expect(store.jobHeaders().map((header) => header.jobId).sort()).toEqual(["historical", "recent", "run", "study", "unacked"]);
    const manifest = JSON.parse(await readFile(report.manifest!, "utf8")) as { jobs: { jobId: string; counts: Record<string, number>; sha256: string }[]; totals: Record<string, number> };
    expect(manifest.totals).toEqual({ jobs: 1, items: 2, receipts: 1 });
    expect(manifest.jobs[0]).toMatchObject({ jobId: "old", counts: { jobs: 1, items: 2, receipts: 1 } });
    const { DatabaseSync } = await import(`node${":sqlite"}`);
    const archived = new DatabaseSync(report.file!, { readOnly: true }); cleanups.push(() => archived.close());
    expect(count(archived, "SELECT count(*) AS n FROM job_items WHERE input IS NOT NULL")).toBe(2);
    expect(count(archived, "SELECT count(*) AS n FROM receipts")).toBe(1);
    expect((await readdir(join(dir, "archive"))).sort()).toHaveLength(2);
    expect(count(db(), "SELECT count(*) AS n FROM blobs")).toBe(2);
    await rm(join(dir, "archive"), { recursive: true });
  });
});
