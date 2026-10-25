import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdvancedStore } from "../../src/advanced/store.js";
import type { WorkerJob } from "../../src/advanced/types.js";
import { createDaemonServer } from "../../src/daemon/server.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

const TOKEN = "ops-idle-token";
const auth = { authorization: `Bearer ${TOKEN}` };

function job(id: string, state: WorkerJob["state"]): WorkerJob {
  return {
    jobId: id,
    kind: "agent",
    state,
    parentSessionName: "parent",
    attemptId: "attempt",
    configRevision: 1,
    config: {
      id: "refs",
      assignment: "Review",
      agent: "codex",
      modelProvider: { id: "local", model: "test", kind: "codex-openai-compatible" }
    },
    idempotencyKey: id,
    fingerprint: id,
    createdAt: "2026-10-25T00:00:00Z",
    updatedAt: "2026-10-25T00:00:00Z",
    request: { configId: "refs", idempotencyKey: id, task: "Review" } as WorkerJob["request"],
    results: []
  };
}

async function waitForFile(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await readFile(path, "utf8").then(() => true, () => false)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe("GET /ops/idle", () => {
  it("counts broker jobs by state", async () => {
    const store = await AdvancedStore.open(await createTempDir("puppenclaw-ops-jobs-"));
    try {
      for (const [id, state] of [
        ["a", "queued"],
        ["b", "running"],
        ["c", "running"],
        ["d", "paused"],
        ["e", "completed"],
        ["f", "interrupted"]
      ] as const) {
        store.putJob(job(id, state));
      }
      expect(store.countJobsByState()).toEqual({
        queued: 1,
        running: 2,
        paused: 1,
        completed: 1,
        failed: 0,
        cancelled: 0,
        interrupted: 1
      });
    } finally {
      store.close();
    }
  });

  it("reports counts only, behind authentication, and follows a turn from start to stop", async () => {
    const dataDir = await createTempDir("puppenclaw-ops-idle-");
    const workspace = await createTempDir("puppenclaw-ops-idle-ws-");
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand(), daemonAuthToken: TOKEN }),
      dataDir,
      logger: { info() {}, warn() {}, error() {}, debug() {} }
    });
    const idle = async () => {
      const response = await app.inject({ method: "GET", url: "/ops/idle", headers: auth });
      expect(response.statusCode).toBe(200);
      return JSON.parse(response.body) as { counts: Record<string, number>; bootId: string };
    };
    try {
      expect((await app.inject({ method: "GET", url: "/ops/idle" })).statusCode).toBe(401);
      const quiet = await idle();
      expect(quiet).toMatchObject({ ok: true, protocol: { major: 2, minor: 0 } });
      expect(quiet.counts).toEqual({
        activeTurns: 0,
        turnProcesses: 0,
        runnerProcesses: 0,
        runningTurnKeys: 0,
        recoveryFencedSessions: 0,
        brokerJobsActive: 0,
        brokerJobsPaused: 0,
        computeJobsActive: 0,
        streams: 0,
        leftoverRunnerGroups: 0
      });

      const turn = app.inject({
        method: "POST",
        url: "/session/start/stream",
        headers: auth,
        payload: {
          agent: "claude",
          name: "ops-idle-busy",
          directory: workspace,
          task: "SLOW_TURN hold the turn",
          turnKey: "ops:idle:1"
        }
      });
      expect(await waitForFile(join(workspace, ".fake-acpx-state", "ops-idle-busy.slow"))).toBe(true);
      const busy = await idle();
      expect(busy.counts).toMatchObject({
        activeTurns: 1,
        turnProcesses: 1,
        runningTurnKeys: 1,
        streams: 1
      });
      expect(busy.counts.runnerProcesses).toBeGreaterThanOrEqual(1);
      const raw = (await app.inject({ method: "GET", url: "/ops/idle", headers: auth })).body;
      expect(raw).not.toContain("ops-idle-busy");
      expect(raw).not.toContain("ops:idle:1");

      const stopped = await app.inject({ method: "DELETE", url: "/session/ops-idle-busy", headers: auth });
      expect(stopped.statusCode).toBe(200);
      await turn;
      const after = await idle();
      expect(after.counts).toMatchObject({ activeTurns: 0, turnProcesses: 0, runningTurnKeys: 0, streams: 0 });
    } finally {
      await app.close();
    }
  }, 30_000);
});
