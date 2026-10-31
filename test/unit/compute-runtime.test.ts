import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { computeExecutorCapabilities } from "../../src/compute/capabilities.js";
import {
  executorConstraintError,
  isPathWithinRoots,
} from "../../src/compute/runtime.js";
import { ComputeStore } from "../../src/compute/store.js";
import {
  computeJobRecordZod,
  computeJobSpecZod,
  type ComputeJobRecord,
} from "../../src/compute/types.js";
import { createTempDir } from "../helpers.js";

const NODE_SQLITE_SPECIFIER = `node${":sqlite"}`;

function makeRecord(overrides: Partial<ComputeJobRecord> & { id: string }): ComputeJobRecord {
  return {
    state: "running",
    sessionName: null,
    executor: "bubblewrap-local",
    command: ["true"],
    cwd: "/share/work/chat",
    resources: {
      cpuCores: 1,
      memoryMiB: 128,
      wallTimeSeconds: 30,
      gpuCount: 0,
      diskMiB: 0
    },
    supervisorPid: 100,
    supervisorStartTicks: "123",
    childPid: 101,
    childStartTicks: "124",
    stdoutPath: null,
    stderrPath: null,
    exitCode: null,
    failureCode: null,
    failureMessage: null,
    submittedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    lastHeartbeatAt: null,
    peakMemoryKiB: null,
    cpuSeconds: null,
    readBytes: null,
    writeBytes: null,
    ...overrides
  };
}

describe("managed compute runtime", () => {
  it("uses boundary-aware workspace confinement", () => {
    expect(isPathWithinRoots("/share/work/chat/results", ["/share/work/chat"])).toBe(true);
    expect(isPathWithinRoots("/share/work/chat-other", ["/share/work/chat"])).toBe(false);
  });

  it("keeps future executors unavailable until their adapters are configured", () => {
    const capabilities = computeExecutorCapabilities({ hasAllowedRoots: false });
    expect(capabilities.find((entry) => entry.id === "bubblewrap-local")?.available).toBe(false);
    expect(capabilities.find((entry) => entry.id === "rootless-docker")?.available).toBe(false);
    expect(capabilities.find((entry) => entry.id === "slurm")?.available).toBe(false);
  });

  it("rejects GPU requests until device allocation is enforceable", () => {
    expect(
      executorConstraintError({
        jobId: "job-gpu",
        executor: "bubblewrap-local",
        command: ["true"],
        cwd: "/share/work/chat",
        env: {},
        resources: {
          cpuCores: 1,
          memoryMiB: 128,
          wallTimeSeconds: 30,
          gpuCount: 1,
          diskMiB: 0,
        },
      }),
    ).toMatch(/device isolation/iu);
  });

  it("persists job identity and state in sqlite", async () => {
    const root = await createTempDir("puppenclaw-compute-store-");
    const store = await ComputeStore.open(root);
    try {
      store.upsert(makeRecord({ id: "job-1", cwd: root }));
      expect(store.get("job-1")?.supervisorStartTicks).toBe("123");
      expect(store.listActive()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("accepts an optional sessionName in the job spec", () => {
    const base = {
      jobId: "job-spec",
      executor: "bubblewrap-local",
      command: ["true"],
      cwd: "/share/work/chat",
      resources: { cpuCores: 1, memoryMiB: 128, wallTimeSeconds: 30 }
    };
    expect(computeJobSpecZod.parse(base).sessionName).toBeUndefined();
    expect(
      computeJobSpecZod.parse({ ...base, sessionName: " chat-a " }).sessionName
    ).toBe("chat-a");
    expect(() => computeJobSpecZod.parse({ ...base, sessionName: "  " })).toThrow();
  });

  it("parses legacy record payloads without sessionName to null", () => {
    const legacy = makeRecord({ id: "job-legacy" }) as Record<string, unknown>;
    delete legacy.sessionName;
    expect(computeJobRecordZod.parse(legacy).sessionName).toBeNull();
  });

  it("migrates legacy databases by adding session_name idempotently", async () => {
    const root = await createTempDir("puppenclaw-compute-legacy-");
    const { DatabaseSync } = await import(NODE_SQLITE_SPECIFIER);
    const db = new DatabaseSync(join(root, "compute.sqlite"));
    db.exec(`
      CREATE TABLE compute_jobs (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    const legacy = makeRecord({ id: "job-legacy" }) as Record<string, unknown>;
    delete legacy.sessionName;
    db.prepare(
      "INSERT INTO compute_jobs (id, state, submitted_at, updated_at, payload) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "job-legacy",
      "running",
      String(legacy.submittedAt),
      String(legacy.submittedAt),
      JSON.stringify(legacy)
    );
    db.close();

    const store = await ComputeStore.open(root);
    try {
      // Legacy payload parses with a null linkage and stays listed as active.
      expect(store.get("job-legacy")?.sessionName).toBeNull();
      expect(store.listActive()).toHaveLength(1);
      expect(store.listActiveBySession("chat-a")).toHaveLength(0);
    } finally {
      store.close();
    }
    // Second open must not attempt the ALTER again.
    const reopened = await ComputeStore.open(root);
    reopened.close();
  });

  it("round-trips sessionName and lists active jobs by session", async () => {
    const root = await createTempDir("puppenclaw-compute-linked-");
    const store = await ComputeStore.open(root);
    try {
      store.upsert(makeRecord({ id: "job-linked", sessionName: "chat-a" }));
      store.upsert(makeRecord({ id: "job-unlinked" }));
      store.upsert(makeRecord({ id: "job-done", sessionName: "chat-a", state: "succeeded" }));
      expect(store.get("job-linked")?.sessionName).toBe("chat-a");
      expect(store.get("job-unlinked")?.sessionName).toBeNull();
      expect(store.listActive()).toHaveLength(2);
      expect(store.listActiveBySession("chat-a").map((job) => job.id)).toEqual(["job-linked"]);
      expect(store.listActiveBySession("chat-b")).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

describe("managed compute submissions", () => {
  it("starts one supervisor for overlapping submissions of the same job id, the late first one included", async () => {
    const { writeFile, readFile, mkdir } = await import("node:fs/promises");
    const { vi } = await import("vitest");
    const root = await createTempDir("puppenclaw-compute-submit-");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    // A supervisor stand-in that only records that it was started.
    const started = join(root, "started.log");
    const supervisor = join(root, "supervisor.mjs");
    await writeFile(
      supervisor,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(started)}, "started\\n");\n`
    );
    const capabilities = await import("../../src/compute/capabilities.js");
    const probe = vi.spyOn(capabilities, "computeExecutorCapabilities").mockReturnValue([
      { id: "bubblewrap-local", available: true, hardLimits: false }
    ]);
    const { ComputeRuntime } = await import("../../src/compute/runtime.js");
    const { makeConfig } = await import("../helpers.js");
    const runtime = await ComputeRuntime.open({
      dataDir: join(root, "data"),
      config: makeConfig({ orchestration: { localWorker: { projectRoots: [workspace] } } }),
      supervisorPath: supervisor
    });
    try {
      const spec = {
        jobId: "study-step-1",
        executor: "bubblewrap-local",
        command: ["true"],
        cwd: workspace,
        env: {},
        resources: { cpuCores: 1, memoryMiB: 128, wallTimeSeconds: 30, gpuCount: 0, diskMiB: 0 }
      };
      // The resubmission and the delayed first submission overlap.
      const [first, second] = await Promise.all([runtime.submit(spec), runtime.submit(spec)]);
      expect(first.id).toBe("study-step-1");
      expect(second.id).toBe("study-step-1");
      // A third one, after both, meets the stored job.
      expect((await runtime.submit(spec)).id).toBe("study-step-1");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const lines = (await readFile(started, "utf8")).trim().split("\n");
      expect(lines).toEqual(["started"]);
    } finally {
      runtime.close();
      probe.mockRestore();
    }
  });
});
