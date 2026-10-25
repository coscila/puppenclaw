import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdvancedStore } from "../src/advanced/store.js";
import { BulkConcurrencyLimiter, bulkConcurrencyFromEnvironment } from "../src/advanced/concurrency.js";
import { BrokerUsageAccumulator } from "../src/statistics/broker-usage.js";
import type { UsageReceipt, WorkerJob } from "../src/advanced/types.js";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const root = () => mkdtemp(join(tmpdir(), "advanced-scaling-"));
function job(id = "job"): WorkerJob {
  return { jobId: id, kind: "bulk", state: "running", parentSessionName: "parent", attemptId: "attempt", configRevision: 1,
    config: { id: "refs", assignment: "Review", agent: "codex", modelProvider: { id: "local", model: "test", kind: "codex-openai-compatible" } },
    idempotencyKey: id, fingerprint: id, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    request: { configId: "refs", idempotencyKey: id, concurrency: 2, items: ["one", "two", "three"].map((id) => ({ id, input: `PRIVATE INPUT ${id}` })) },
    results: ["one", "two", "three"].map((id) => ({ id, state: "queued", providerId: "local", model: "test", promptSha256: id, usage: null })) };
}
describe("incremental worker persistence", () => {
  it("migrates legacy job blobs without dropping completed results, request inputs or idempotency", async () => {
    const dir = await root(); const { DatabaseSync } = await import(`node${":sqlite"}`); const db = new DatabaseSync(join(dir, "advanced.sqlite"));
    db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY,parent TEXT NOT NULL,attempt TEXT NOT NULL,request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(parent,attempt,request_key)); CREATE TABLE receipts (id TEXT PRIMARY KEY,parent TEXT NOT NULL,attempt TEXT NOT NULL,payload TEXT NOT NULL)");
    const original = job(); original.results[0]!.state = "completed"; original.results[0]!.output = "ACCEPTED";
    db.prepare("INSERT INTO jobs VALUES (?,?,?,?,?,?)").run(original.jobId, original.parentSessionName, original.attemptId, original.idempotencyKey, original.fingerprint, JSON.stringify(original)); db.close();
    const store = await AdvancedStore.open(dir); cleanups.push(() => store.close());
    expect(store.job("job")).toEqual(original); expect(store.duplicate("parent", "attempt", "job")).toEqual(original);
    store.recover(); expect(store.job("job")!.results.map((r) => r.state)).toEqual(["completed", "interrupted", "interrupted"]);
  });
  it("keeps immutable input rows out of per-item updates and exposes resumable changed-since pages", async () => {
    const dir = await root(), store = await AdvancedStore.open(dir); cleanups.push(() => store.close()); store.putJob(job()); store.putJob(job("other"));
    const initial = store.summaries("parent", { limit: 1 }); expect(initial.hasMore).toBe(true); expect(initial.jobs).toHaveLength(1);
    const next = store.summaries("parent", { after: initial.nextCursor, limit: 1 }); expect(next.jobs[0]!.job.jobId).toBe("other");
    const firstResults = store.resultPage("job", { limit: 2 }); expect(firstResults.results.map((r) => r.id)).toEqual(["one", "two"]); expect(firstResults.hasMore).toBe(true);
    const last = store.resultPage("job", { after: firstResults.nextCursor }); expect(last.results.map((r) => r.id)).toEqual(["three"]);
    const { DatabaseSync } = await import(`node${":sqlite"}`); const db = new DatabaseSync(join(dir, "advanced.sqlite")); cleanups.push(() => db.close());
    db.exec("CREATE TRIGGER reject_input_update BEFORE UPDATE OF input ON job_items BEGIN SELECT RAISE(ABORT,'inputs must remain untouched'); END");
    store.updateItem("job", "two", { state: "completed", output: "LARGE VERIFIED OUTPUT" });
    const changed = store.resultPage("job", { after: last.nextCursor }); expect(changed.results).toMatchObject([{ id: "two", state: "completed", output: "LARGE VERIFIED OUTPUT" }]);
    expect(store.resultPage("job", { after: changed.nextCursor })).toMatchObject({ results: [], hasMore: false, nextCursor: changed.nextCursor });
    const updated = store.summaries("parent", { after: next.nextCursor }); expect(updated.jobs).toHaveLength(1); expect(updated.jobs[0]!.progress).toMatchObject({ total: 3, completed: 1, queued: 2, failed: 0 });
    const payload = (db.prepare("SELECT payload FROM jobs WHERE id='job'").get() as { payload: string }).payload;
    expect(payload).not.toContain("PRIVATE INPUT"); expect(payload).not.toContain("LARGE VERIFIED OUTPUT");
    expect(store.job("job")!.request).toEqual(job().request);
    expect(() => store.resultPage("job", { after: -1 })).toThrow(); expect(() => store.summaries("parent", { limit: 1001 })).toThrow();
  });
  it("keeps revision cursors monotonic across reopen and removes item contents on erasure", async () => {
    const dir = await root(); let store = await AdvancedStore.open(dir); store.putJob(job()); const cursor = store.summaries().nextCursor; store.close();
    store = await AdvancedStore.open(dir); cleanups.push(() => store.close()); store.updateItem("job", "one", { state: "completed" });
    expect(store.summaries("parent", { after: cursor }).nextCursor).toBeGreaterThan(cursor);
    // The job's broker.job event is not acknowledged: the erasure waits until the feed has it.
    store.purgeSession("parent"); expect(store.deferredPurges()).toEqual(["job"]); expect(store.resultPage("job").results).toHaveLength(3);
    store.ack(store.feedId, store.head());
    expect(store.resultPage("job").results).toEqual([]); expect(store.jobHeaders()).toEqual([]); expect(store.deferredPurges()).toEqual([]);
  });
});

describe("aggregate provider dispatch capacity", () => {
  it("reports actual shared permits and waiting requests across transfer and cancellation", async () => {
    const limiter = new BulkConcurrencyLimiter({ defaultLimit: 1, providerLimits: { other: 3 } });
    expect(limiter.snapshot("qwen")).toEqual({ limit: 1, active: 0, waiting: 0 });
    const first = await limiter.acquire("qwen", new AbortController().signal);
    const second = limiter.acquire("qwen", new AbortController().signal);
    const cancelled = new AbortController();
    const third = limiter.acquire("qwen", cancelled.signal);
    expect(limiter.snapshot("qwen")).toEqual({ limit: 1, active: 1, waiting: 2 });
    expect(limiter.snapshot("other")).toEqual({ limit: 3, active: 0, waiting: 0 });
    const detached = limiter.snapshot("qwen"); detached.active = 99; detached.waiting = 99;
    expect(limiter.snapshot("qwen")).toEqual({ limit: 1, active: 1, waiting: 2 });
    cancelled.abort(); await expect(third).rejects.toThrow("cancelled");
    expect(limiter.snapshot("qwen")).toEqual({ limit: 1, active: 1, waiting: 1 });
    first();
    expect(limiter.snapshot("qwen")).toEqual({ limit: 1, active: 1, waiting: 0 });
    const release = await second; release(); release();
    expect(limiter.snapshot("qwen")).toEqual({ limit: 1, active: 0, waiting: 0 });
  });
  it("shares slots across jobs, isolates providers and aborts waiting dispatch without consuming a slot", async () => {
    const limiter = new BulkConcurrencyLimiter({ defaultLimit: 1, providerLimits: { another: 2 } }); const abort = new AbortController();
    const first = await limiter.acquire("qwen", abort.signal); let admitted = false;
    const waiting = limiter.acquire("qwen", abort.signal).then((release) => { admitted = true; return release; });
    const different = await limiter.acquire("another", new AbortController().signal); expect(admitted).toBe(false);
    const cancelled = new AbortController(); const rejected = limiter.acquire("qwen", cancelled.signal); cancelled.abort(); await expect(rejected).rejects.toThrow("cancelled");
    first(); const release = await waiting; expect(admitted).toBe(true); release(); different();
    const final = await limiter.acquire("qwen", new AbortController().signal); final();
  });
  it("rejects malformed configuration instead of silently disabling the cap", () => {
    expect(bulkConcurrencyFromEnvironment({})).toEqual({ defaultLimit: 60, providerLimits: {} });
    expect(new BulkConcurrencyLimiter({ defaultLimit: 3 }).limit("constructor")).toBe(3);
    expect(() => bulkConcurrencyFromEnvironment({ PUPPENCLAW_BULK_PROVIDER_LIMITS: '{"qwen":true}' })).toThrow();
    expect(bulkConcurrencyFromEnvironment({ PUPPENCLAW_BULK_PROVIDER_CONCURRENCY: "3", PUPPENCLAW_BULK_PROVIDER_LIMITS: '{"qwen":2}' })).toEqual({ defaultLimit: 3, providerLimits: { qwen: 2 } });
    for (const value of ["0", "NaN", "-1", "1.5", "Infinity", String(Number.MAX_SAFE_INTEGER + 1)]) expect(() => bulkConcurrencyFromEnvironment({ PUPPENCLAW_BULK_PROVIDER_CONCURRENCY: value })).toThrow();
  });
  it("accepts operator capacities above 10000 while preserving provider-specific shared limits", async () => {
    const options = bulkConcurrencyFromEnvironment({ PUPPENCLAW_BULK_PROVIDER_CONCURRENCY: "10001", PUPPENCLAW_BULK_PROVIDER_LIMITS: JSON.stringify({ qwen: Number.MAX_SAFE_INTEGER, bounded: 1 }) });
    const limiter = new BulkConcurrencyLimiter(options);
    expect(limiter.limit("default")).toBe(10001);
    expect(limiter.limit("qwen")).toBe(Number.MAX_SAFE_INTEGER);
    expect(limiter.limit("bounded")).toBe(1);
    const first = await limiter.acquire("bounded", new AbortController().signal);
    let admitted = false;
    const second = limiter.acquire("bounded", new AbortController().signal).then((release) => { admitted = true; return release; });
    await Promise.resolve(); expect(admitted).toBe(false);
    first(); (await second)(); expect(admitted).toBe(true);
  });
});

function receipt(id: string, input: number | null, model = "test"): UsageReceipt {
  return { version: 1, requestId: id, parentSessionName: "parent", sessionName: "parent", attemptId: "attempt", providerId: "local", model, role: "subagent", jobId: "job", promptSha256: id, state: "completed", createdAt: "now", updatedAt: "now",
    usage: { input, output: 2, total: input === null ? null : input + 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, quality: input === null ? "partial" : "measured" } };
}
describe("incremental broker statistics", () => {
  it("replaces cumulative receipts, preserves unknowns and transfers corrected model attribution", () => {
    const usage = new BrokerUsageAccumulator(); const first = receipt("a", null); first.state = "running"; usage.update(first); usage.update(receipt("b", 20));
    expect(usage.snapshot()).toMatchObject({ tokens: { input: null, quality: "partial" }, incomplete: true });
    first.usage = receipt("a", 10).usage; first.state = "completed"; first.model = "actual"; usage.update(first); usage.update(first);
    const final = usage.snapshot(); expect(final.tokens).toMatchObject({ input: 30, output: 4, total: 34, quality: "measured" }); expect(final.incomplete).toBe(false);
    expect(final.models).toHaveLength(2); expect(final.models.find((m) => m.model === "actual")).toMatchObject({ threads: 1, tokens: { input: 10 } });
    first.usage.input = 9000; expect(usage.snapshot().tokens.input).toBe(30);
  });
  it("handles unsafe totals without poisoning later corrections", () => {
    const usage = new BrokerUsageAccumulator(); usage.update(receipt("a", Number.MAX_SAFE_INTEGER - 2)); usage.update(receipt("b", 10)); expect(usage.snapshot().tokens.input).toBeNull();
    usage.update(receipt("a", 1)); expect(usage.snapshot().tokens.input).toBe(11);
  });
});
