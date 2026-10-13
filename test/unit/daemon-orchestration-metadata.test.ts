import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDaemonServer } from "../../src/daemon/server.js";
import { AdvancedStore } from "../../src/advanced/store.js";
import type { WorkerJob } from "../../src/advanced/types.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

const AUTH = { authorization: "Bearer secret-token" };
const now = "2026-10-13T05:00:00.000Z";
function job(jobId: string, parentSessionName: string): WorkerJob {
  return {
    jobId, parentSessionName, attemptId: "attempt-1", kind: "agent", state: "cancelled", ownerKey: "PRIVATE OWNER", configRevision: 1,
    config: { id: "w1", assignment: "PRIVATE ASSIGNMENT", agent: "codex", modelProvider: { id: "local", kind: "codex-openai-compatible", model: "test", baseUrl: "http://127.0.0.1:9999/v1", authTokenEnv: "PRIVATE_ENV" } },
    idempotencyKey: jobId, fingerprint: "private-fingerprint", createdAt: now, updatedAt: now,
    request: { configId: "w1", idempotencyKey: jobId, task: "PRIVATE PROMPT" },
    results: [{ id: "result", state: "cancelled", output: "PRIVATE OUTPUT", providerId: "local", model: "test", promptSha256: "private-hash", usage: null, error: "PRIVATE ERROR" }]
  };
}

describe("daemon worker metadata", () => {
  it("keeps health snapshots authenticated, session scoped and free of worker contents", async () => {
    const dataDir = await createTempDir("puppenclaw-worker-metadata-");
    const store = await AdvancedStore.open(join(dataDir, "advanced"));
    store.putJob({ ...job("job-a", "chat-a"), resumedFromJobId: "original-job" });
    store.putJob(job("job-b", "chat-b"));
    store.close();
    const { app } = await createDaemonServer({ config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand(), daemonAuthToken: "secret-token" }), dataDir });
    try {
      const url = "/orchestration/jobs?session=chat-a&metadata-only=true";
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      const response = await app.inject({ method: "GET", url, headers: AUTH });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ jobs: [{ jobId: "job-a", resumedFromJobId: "original-job", parentSessionName: "chat-a", attemptId: "attempt-1", kind: "agent", state: "cancelled", createdAt: now, updatedAt: now }] });
      expect(response.body).not.toContain("PRIVATE");
      const full = await app.inject({ method: "GET", url: "/orchestration/jobs?session=chat-a", headers: AUTH });
      expect(full.json().jobs[0].results[0].output).toBe("PRIVATE OUTPUT");
      const capabilities = await app.inject({ method: "GET", url: "/capabilities", headers: AUTH });
      expect(capabilities.json().advancedOrchestration.workerJoinContinuation).toBe(true);
    } finally { await app.close(); }
  });
});
