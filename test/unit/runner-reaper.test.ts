import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDaemonServer } from "../../src/daemon/server.js";
import {
  bootReaperModeFromEnv,
  countLiveLeftoverRunnerGroups,
  reapRunnerGroups,
  RunnerRegistry,
  runnerRegistryDir,
  type RunnerRecord
} from "../../src/manager/runner-registry.js";
import {
  processGroupMayExist,
  readKernelBootId,
  readLinuxProcessStat
} from "../../src/shared/process-identity.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

const spawned: ChildProcess[] = [];

function spawnGroup(script: string): ChildProcess {
  const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
  spawned.push(child);
  return child;
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return await check();
}

async function recordFor(
  child: ChildProcess,
  overrides: Partial<RunnerRecord> = {}
): Promise<RunnerRecord> {
  const stat = await readLinuxProcessStat(child.pid!);
  if (stat == null) {
    throw new Error("child already gone");
  }
  return {
    version: 1,
    pid: child.pid!,
    processGroupId: stat.processGroupId,
    processStartIdentity: stat.processStartIdentity,
    kind: "turn",
    sessionName: "leftover",
    bootId: "previous-boot",
    ownerPid: 999_999_999,
    spawnedAt: new Date().toISOString(),
    ...overrides
  };
}

async function writeRecord(dataDir: string, record: RunnerRecord, name = `${record.pid}.1.json`): Promise<void> {
  await mkdir(runnerRegistryDir(dataDir), { recursive: true });
  await writeFile(join(runnerRegistryDir(dataDir), name), JSON.stringify(record), "utf8");
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const child of spawned.splice(0)) {
    if (child.pid != null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
});

describe("boot reaper mode", () => {
  it("defaults to observe and accepts off, observe and on", () => {
    expect(bootReaperModeFromEnv({})).toBe("observe");
    expect(bootReaperModeFromEnv({ PUPPENCLAW_BOOT_REAPER: "ON" })).toBe("on");
    expect(bootReaperModeFromEnv({ PUPPENCLAW_BOOT_REAPER: "off" })).toBe("off");
    expect(bootReaperModeFromEnv({ PUPPENCLAW_BOOT_REAPER: "kill" })).toBe("observe");
  });
});

describe.runIf(process.platform === "linux")("runner registry and boot reaper", () => {
  it("records each tracked runner group while it lives and forgets it on close", async () => {
    const dataDir = await createTempDir("puppenclaw-runner-registry-");
    const registry = await RunnerRegistry.open({ dataDir, bootId: "boot-a", mode: "observe" });
    const child = spawnGroup("sleep 30");
    registry.track(child, { kind: "turn", sessionName: "registry-demo" });
    expect(registry.counts()).toEqual({ total: 1, turn: 1, control: 0 });
    const dir = runnerRegistryDir(dataDir);
    expect(await waitUntil(async () => (await readdir(dir)).length === 1)).toBe(true);
    const [file] = await readdir(dir);
    const record = JSON.parse(await readFile(join(dir, file!), "utf8")) as RunnerRecord;
    expect(record).toMatchObject({
      version: 1,
      pid: child.pid,
      processGroupId: child.pid,
      kind: "turn",
      sessionName: "registry-demo",
      bootId: "boot-a",
      ownerPid: process.pid,
      kernelBootId: await readKernelBootId()
    });
    expect(record.processStartIdentity).toMatch(new RegExp(`^${child.pid}:\\d+$`, "u"));

    const closed = new Promise((resolve) => child.once("close", resolve));
    process.kill(-child.pid!, "SIGKILL");
    await closed;
    expect(registry.counts().total).toBe(0);
    expect(await waitUntil(async () => (await readdir(dir)).length === 0)).toBe(true);
  });

  it("writes nothing when the reaper is off", async () => {
    const dataDir = await createTempDir("puppenclaw-runner-registry-off-");
    const registry = await RunnerRegistry.open({ dataDir, bootId: "boot-off", mode: "off" });
    const child = spawnGroup("sleep 30");
    registry.track(child, { kind: "control" });
    expect(registry.counts()).toEqual({ total: 1, turn: 0, control: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readdir(dataDir)).toEqual([]);
    const report = await reapRunnerGroups({ dataDir, bootId: "boot-next", mode: "off" });
    expect(report.records).toBe(0);
  });

  it("observes leftover groups without signalling them and drops records of gone groups", async () => {
    const dataDir = await createTempDir("puppenclaw-runner-observe-");
    const alive = spawnGroup("sleep 30 & wait");
    await writeRecord(dataDir, await recordFor(alive));
    const gone = spawnGroup("sleep 30");
    const goneRecord = await recordFor(gone, { sessionName: "gone" });
    const goneClosed = new Promise((resolve) => gone.once("close", resolve));
    process.kill(-gone.pid!, "SIGKILL");
    await goneClosed;
    await writeRecord(dataDir, goneRecord);
    await writeFile(join(runnerRegistryDir(dataDir), "garbage.json"), "{", "utf8");

    const messages: string[] = [];
    const report = await reapRunnerGroups({
      dataDir,
      bootId: "boot-b",
      mode: "observe",
      log: (message) => messages.push(message)
    });

    expect(report).toEqual({
      mode: "observe",
      records: 2,
      gone: 1,
      terminated: 0,
      survivors: 1,
      unverified: 0,
      terminatedTurnSessions: []
    });
    expect(processGroupMayExist(alive.pid!)).toBe(true);
    expect(await readdir(runnerRegistryDir(dataDir))).toEqual([`${alive.pid}.1.json`]);
    expect(messages.join("\n")).toContain("is still running");
  });

  it("terminates a verified leftover group with all of its members when on", async () => {
    const dataDir = await createTempDir("puppenclaw-runner-on-");
    const leader = spawnGroup("trap '' TERM; sleep 30 & wait");
    await writeRecord(dataDir, await recordFor(leader, { sessionName: "lab-chat-1" }));

    const report = await reapRunnerGroups({
      dataDir,
      bootId: "boot-c",
      mode: "on",
      terminationTimeoutMs: 1_000
    });

    expect(report).toMatchObject({ records: 1, terminated: 1, survivors: 0, terminatedTurnSessions: ["lab-chat-1"] });
    expect(processGroupMayExist(leader.pid!)).toBe(false);
    expect(await readdir(runnerRegistryDir(dataDir))).toEqual([]);
  });

  it("never signals or counts a group recorded during an earlier host boot, even when its pid and start ticks match", async () => {
    const dataDir = await createTempDir("puppenclaw-runner-other-boot-");
    // A live group whose pid and start ticks match the record: after a host
    // reboot, an unrelated process that happens to match them.
    const foreign = spawnGroup("sleep 30 & wait");
    await writeRecord(dataDir, await recordFor(foreign, { kernelBootId: "an-earlier-host-boot" }));
    // The same group recorded during this host boot still counts as live.
    const current = await readKernelBootId();
    const ours = spawnGroup("sleep 30 & wait");
    await writeRecord(dataDir, await recordFor(ours, current != null ? { kernelBootId: current } : {}));

    expect(await countLiveLeftoverRunnerGroups({ dataDir, bootId: "boot-e", mode: "on" })).toBe(1);
    const report = await reapRunnerGroups({ dataDir, bootId: "boot-e", mode: "on", terminationTimeoutMs: 1_000 });

    expect(report).toMatchObject({ records: 2, gone: 1, terminated: 1 });
    expect(processGroupMayExist(foreign.pid!)).toBe(true);
    expect(processGroupMayExist(ours.pid!)).toBe(false);
    expect(await readdir(runnerRegistryDir(dataDir))).toEqual([]);
  });

  it("never signals a group whose recorded leader is gone or was replaced", async () => {
    const dataDir = await createTempDir("puppenclaw-runner-unverified-");
    const orphaned = spawnGroup("sleep 30 & sleep 0.3");
    const orphanedRecord = await recordFor(orphaned);
    await new Promise((resolve) => orphaned.once("exit", resolve));
    await writeRecord(dataDir, orphanedRecord);
    // A record naming this very worker with a stale start identity models PID reuse.
    const own = await readLinuxProcessStat(process.pid);
    await writeRecord(
      dataDir,
      {
        ...orphanedRecord,
        pid: process.pid,
        processGroupId: own!.processGroupId,
        processStartIdentity: `${process.pid}:1`,
        sessionName: "reused-pid"
      },
      "reused.json"
    );

    const report = await reapRunnerGroups({ dataDir, bootId: "boot-d", mode: "on", terminationTimeoutMs: 500 });

    expect(report).toMatchObject({ records: 2, terminated: 0, unverified: 2 });
    expect(processGroupMayExist(orphaned.pid!)).toBe(true);
    expect((await readdir(runnerRegistryDir(dataDir))).sort()).toEqual([`${orphanedRecord.pid}.1.json`, "reused.json"]);
  });

  it("boots with the reaper on: kills the leftover turn group, settles the turn and cancels its runtime", async () => {
    vi.stubEnv("PUPPENCLAW_BOOT_REAPER", "on");
    const dataDir = await createTempDir("puppenclaw-runner-boot-");
    const workspace = await createTempDir("puppenclaw-runner-boot-workspace-");
    const logPath = join(workspace, "acpx-calls.log");
    const wrapper = join(workspace, "logging-acpx.sh");
    await writeFile(
      wrapper,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(logPath)}\nexec ${JSON.stringify(await resolveFakeAcpxCommand())} "$@"\n`,
      "utf8"
    );
    await chmod(wrapper, 0o755);

    const leader = spawnGroup("trap '' TERM; sleep 30 & wait");
    const record = await recordFor(leader, { sessionName: "lab-reaped" });
    await writeRecord(dataDir, record);
    const now = new Date().toISOString();
    await writeFile(
      join(dataDir, "state.json"),
      JSON.stringify({
        version: 1,
        turnRequests: {},
        turnGenerations: {},
        exposures: {},
        quiescence: { lastEpoch: 0, active: {}, latestByName: {} },
        sessions: {
          "lab-reaped": {
            name: "lab-reaped",
            agent: "claude",
            directory: workspace,
            state: "running",
            createdAt: now,
            lastActivity: now,
            permissionMode: "approve-reads",
            warnings: [],
            transcript: [],
            activeTurn: {
              id: "turn-reaped",
              state: "running",
              startedAt: now,
              updatedAt: now,
              outputChars: 0,
              pid: record.pid,
              processGroupId: record.processGroupId,
              processStartIdentity: record.processStartIdentity
            }
          }
        }
      }),
      "utf8"
    );

    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: wrapper }),
      dataDir,
      logger: { info() {}, warn() {}, error() {}, debug() {} }
    });
    try {
      expect(processGroupMayExist(leader.pid!)).toBe(false);
      const status = await app.inject({ method: "GET", url: "/session/lab-reaped" });
      const details = (JSON.parse(status.body) as { details: { session: { state: string; activeTurn: { state: string } } } }).details;
      expect(details.session.state).toBe("failed");
      expect(details.session.activeTurn.state).toBe("orphaned");
      const calls = await readFile(logPath, "utf8");
      expect(calls).toMatch(/cancel --session lab-reaped/u);
      expect(await readdir(runnerRegistryDir(dataDir))).toEqual([]);
    } finally {
      await app.close();
    }
  }, 20_000);
});
