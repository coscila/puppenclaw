import { describe, expect, it } from "vitest";

import { AdvancedMaintenance, maintenanceFromEnvironment } from "../../src/advanced/maintenance.js";
import { AdvancedStore } from "../../src/advanced/store.js";
import type { WorkerJob } from "../../src/advanced/types.js";
import { createTempDir } from "../helpers.js";

function job(id: string, updatedAt: string): WorkerJob {
  return {
    jobId: id, kind: "bulk", state: "completed", parentSessionName: "parent", attemptId: "attempt", configRevision: 1,
    config: { id: "refs", assignment: "Review", agent: "codex", modelProvider: { id: "local", model: "test", kind: "codex-openai-compatible" } },
    idempotencyKey: id, fingerprint: id, createdAt: updatedAt, updatedAt,
    request: { configId: "refs", idempotencyKey: id, concurrency: 1, items: [{ id: "one", input: "x" }] },
    results: [{ id: "one", state: "completed", output: "y", providerId: "local", model: "test", promptSha256: "p", usage: null }]
  };
}

describe("opt-in advanced store maintenance", () => {
  it("stays off by default and refuses settings below the plan's floors", () => {
    expect(maintenanceFromEnvironment({})).toEqual({ archiveAfterDays: null, eventRetentionDays: null });
    expect(maintenanceFromEnvironment({ PUPPENCLAW_ADVANCED_ARCHIVE_DAYS: "30", PUPPENCLAW_EVENT_RETENTION_DAYS: "7" })).toEqual({ archiveAfterDays: 30, eventRetentionDays: 7 });
    for (const env of [{ PUPPENCLAW_ADVANCED_ARCHIVE_DAYS: "29" }, { PUPPENCLAW_EVENT_RETENTION_DAYS: "6" }, { PUPPENCLAW_EVENT_RETENTION_DAYS: "7.5" }, { PUPPENCLAW_ADVANCED_ARCHIVE_DAYS: "soon" }]) {
      expect(() => maintenanceFromEnvironment(env)).toThrow();
    }
  });

  it("prunes acknowledged events past the retention and archives terminal jobs past the archive age", async () => {
    const dir = await createTempDir("advanced-maintenance-");
    let now = new Date("2026-08-01T00:00:00.000Z");
    const store = await AdvancedStore.open(dir, { now: () => now });
    try {
      store.createJob(job("old", "2026-08-01T00:00:00.000Z"));
      store.createJob(job("new", "2026-10-24T00:00:00.000Z"));
      now = new Date("2026-10-25T00:00:00.000Z");
      const lines: string[] = [];
      const off = new AdvancedMaintenance(store, { archiveAfterDays: null, eventRetentionDays: null }, (line) => lines.push(line), () => now.getTime());
      expect(off.prune()).toBe(0); expect(await off.archive()).toBeNull();
      const on = new AdvancedMaintenance(store, { archiveAfterDays: 30, eventRetentionDays: 7 }, (line) => lines.push(line), () => now.getTime());
      expect(on.prune()).toBe(0);
      expect((await on.archive())!.jobs).toBe(0);
      store.ack(store.feedId, store.head());
      expect((await on.archive())!.jobs).toBe(1);
      expect(store.jobHeaders().map((header) => header.jobId)).toEqual(["new"]);
      // The archived job's events went with it; the other job's acknowledged event is older than 7 days.
      expect(on.prune()).toBe(1);
      expect(store.events(0, 10).events).toEqual([]);
      expect(lines.some((line) => line.startsWith("ADVANCED_ARCHIVED jobs=1"))).toBe(true);
      on.start(); await on.stop();
    } finally { store.close(); }
  });
});
