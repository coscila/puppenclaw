import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

import { AdvancedStore } from "../../src/advanced/store.js";
import type { BrokerEvent } from "../../src/advanced/outbox.js";
import type { WorkerJob } from "../../src/advanced/types.js";
import { createTempDir } from "../helpers.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
let childPath = "";

beforeAll(async () => {
  const outDir = await createTempDir("advanced-crash-child-");
  childPath = join(outDir, "child.mjs");
  await build({
    entryPoints: [join(repoRoot, "test", "fixtures", "advanced-store-crash-child.ts")],
    outfile: childPath, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent"
  });
}, 60_000);

function job(id: string, items: number): WorkerJob {
  return {
    jobId: id, kind: "bulk", state: "running", parentSessionName: "parent", attemptId: "attempt", configRevision: 1,
    config: { id: "refs", assignment: "Review", agent: "codex", modelProvider: { id: "local", model: "test", kind: "codex-openai-compatible" } },
    idempotencyKey: id, fingerprint: id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    request: { configId: "refs", idempotencyKey: id, concurrency: 2, items: Array.from({ length: items }, (_, index) => ({ id: `i${index}`, input: `input ${index}` })) },
    results: Array.from({ length: items }, (_, index) => ({ id: `i${index}`, state: "queued" as const, providerId: "local", model: "test", promptSha256: "p", usage: null }))
  };
}

function runChild(args: (string | number)[]): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [childPath, ...args.map(String)], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => { if (code !== 0 && signal == null) reject(new Error(`child failed: ${stderr}`)); else resolveExit({ code, signal }); });
  });
}

type Snapshot = { settled: Set<string>; receipts: Set<string>; events: Map<string, number>; seqs: number[] };

async function snapshot(dir: string, jobId: string): Promise<Snapshot> {
  const { DatabaseSync } = await import(`node${":sqlite"}`);
  const db = new DatabaseSync(join(dir, "advanced.sqlite"));
  try {
    const settled = new Set((db.prepare("SELECT item_id FROM job_items WHERE job_id=? AND state='completed'").all(jobId) as { item_id: string }[]).map((row) => row.item_id));
    const receipts = new Set((db.prepare("SELECT item_id FROM receipts WHERE job_id=?").all(jobId) as { item_id: string }[]).map((row) => row.item_id));
    const events = new Map<string, number>();
    for (const row of db.prepare("SELECT itemId FROM outbox WHERE jobId=? AND type='broker.receipt'").all(jobId) as { itemId: string }[]) events.set(row.itemId, (events.get(row.itemId) ?? 0) + 1);
    const seqs = (db.prepare("SELECT seq FROM outbox ORDER BY seq").all() as { seq: number }[]).map((row) => Number(row.seq));
    return { settled, receipts, events, seqs };
  } finally { db.close(); }
}

/** Every item is settled, receipted and announced together, or none of the three happened. */
function expectAtomic(state: Snapshot, items: number): void {
  for (let index = 0; index < items; index += 1) {
    const id = `i${index}`;
    const parts = [state.settled.has(id), state.receipts.has(id), state.events.has(id)];
    expect(parts, id).toEqual(parts[0] ? [true, true, true] : [false, false, false]);
    if (parts[0]) expect(state.events.get(id), id).toBe(1);
  }
  expect(state.seqs).toEqual(Array.from({ length: state.seqs.length }, (_, index) => index + 1));
}

describe("P1 AdvancedStore crash safety", () => {
  it("a SIGKILL inside a batch transaction keeps no part of that batch: result, receipt and outbox row stay together", async () => {
    const dir = await createTempDir("advanced-crash-mid-");
    const store = await AdvancedStore.open(dir); store.createJob(job("j", 100)); store.close();
    // Batch 1 (items 0-39) commits; the process dies on the 25th outbox insert of batch 2 (items 40-79).
    const exit = await runChild([dir, "j", 0, 80, 2, 65]);
    expect(exit.signal).toBe("SIGKILL");
    const state = await snapshot(dir, "j");
    expectAtomic(state, 100);
    expect([...state.settled].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))).toEqual(Array.from({ length: 40 }, (_, index) => `i${index}`));
    // The store reopens after the crash; the items of the lost batch are still queued and can run again.
    const reopened = await AdvancedStore.open(dir);
    try {
      expect(reopened.progress("j")).toMatchObject({ total: 100, completed: 40, queued: 60 });
      expect(reopened.events(0, 1_000).events.filter((event) => event.type === "broker.receipt")).toHaveLength(40);
    } finally { reopened.close(); }
  }, 60_000);

  it("the feed never skips or duplicates a seq across clean restarts and SIGKILLs", async () => {
    const dir = await createTempDir("advanced-crash-feed-");
    const store = await AdvancedStore.open(dir); store.createJob(job("j", 400)); store.close();
    const seen: BrokerEvent[] = [];
    let cursor = 0, next = 0;
    const drain = async () => {
      const reader = await AdvancedStore.open(dir);
      try {
        for (;;) {
          const page = reader.events(cursor, 7);
          seen.push(...page.events); cursor = page.next;
          if (!page.hasMore) break;
        }
        reader.ack(reader.feedId, Math.max(reader.acked, cursor - 3));
      } finally { reader.close(); }
    };
    // Four cycles: clean exit, crash mid-batch, clean exit, crash in the first insert of a batch.
    for (const [count, batches, crashAt] of [[50, 2, 0], [80, 3, 40], [60, 1, 0], [90, 3, 1]] as const) {
      await drain();
      const exit = await runChild([dir, "j", next, count, batches, crashAt]);
      if (crashAt === 0) { expect(exit.code).toBe(0); next += count; }
      else {
        expect(exit.signal).toBe("SIGKILL");
        const state = await snapshot(dir, "j");
        expectAtomic(state, 400);
        next = state.settled.size;
      }
    }
    await drain();
    const seqs = seen.map((event) => event.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
    const receiptItems = seen.filter((event) => event.type === "broker.receipt").map((event) => event.itemId);
    expect(new Set(receiptItems).size).toBe(receiptItems.length);
    const final = await snapshot(dir, "j");
    expectAtomic(final, 400);
    expect(receiptItems.length).toBe(final.settled.size);
  }, 120_000);
});
