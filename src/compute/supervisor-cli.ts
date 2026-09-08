#!/usr/bin/env node

import { open, readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

import { computeJobSpecZod, computeJobRecordZod, type ComputeJobRecord } from "./types.js";
import { readProcessStartTicks, readProcessUsage } from "./process.js";
import { writeJsonFileAtomic } from "../shared/utils.js";
import { computeSandboxLaunch } from "./sandbox.js";

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

async function main(): Promise<void> {
  const specPath = arg("--spec");
  const statePath = arg("--state");
  const stdoutPath = arg("--stdout");
  const stderrPath = arg("--stderr");
  const spec = computeJobSpecZod.parse(JSON.parse(await readFile(specPath, "utf8")));
  const submittedAt = arg("--submitted-at");
  let child: ChildProcess | null = null;
  let terminalReason: "cancelled" | "wall_time" | null = null;
  let peakMemoryKiB = 0;
  const base: ComputeJobRecord = computeJobRecordZod.parse({
    id: spec.jobId,
    state: "starting",
    // The heartbeat rewrites the whole record every 5s from this base, so the
    // session linkage MUST be carried here or it would be nulled immediately.
    sessionName: spec.sessionName ?? null,
    executor: spec.executor,
    command: spec.command,
    cwd: spec.cwd,
    resources: spec.resources,
    supervisorPid: process.pid,
    supervisorStartTicks: await readProcessStartTicks(process.pid),
    childPid: null,
    childStartTicks: null,
    stdoutPath,
    stderrPath,
    exitCode: null,
    failureCode: null,
    failureMessage: null,
    submittedAt,
    startedAt: null,
    completedAt: null,
    lastHeartbeatAt: new Date().toISOString(),
    peakMemoryKiB: null,
    cpuSeconds: null,
    readBytes: null,
    writeBytes: null
  });
  let state = base;
  const writeState = async (patch: Partial<ComputeJobRecord>) => {
    state = computeJobRecordZod.parse({ ...state, ...patch });
    await writeJsonFileAtomic(statePath, state);
  };
  await writeState({});

  const stopChild = (reason: "cancelled" | "wall_time") => {
    terminalReason = reason;
    child?.kill("SIGTERM");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 5_000);
    timer.unref();
  };
  process.on("SIGTERM", () => stopChild("cancelled"));
  process.on("SIGINT", () => stopChild("cancelled"));

  const stdout = await open(stdoutPath, "a");
  const stderr = await open(stderrPath, "a");
  try {
    const launch = computeSandboxLaunch(spec);
    child = spawn(launch.command, launch.args, {
      cwd: spec.cwd,
      env: launch.env,
      detached: false,
      stdio: ["ignore", stdout.fd, stderr.fd, "pipe"],
      windowsHide: true
    });
    const environmentPipe = child.stdio[3] as Writable;
    environmentPipe.on("error", () => { /* A fail-closed launcher may exit before reading. */ });
    environmentPipe.end(launch.serializedEnv);
    const startedAt = new Date().toISOString();
    await writeState({
      state: "running",
      childPid: child.pid ?? null,
      childStartTicks: child.pid ? await readProcessStartTicks(child.pid) : null,
      startedAt,
      lastHeartbeatAt: startedAt
    });
    const heartbeat = setInterval(() => {
      if (!child?.pid) return;
      void readProcessUsage(child.pid).then((usage) => {
        peakMemoryKiB = Math.max(peakMemoryKiB, usage.peakMemoryKiB ?? 0);
        return writeState({
          ...usage,
          peakMemoryKiB,
          lastHeartbeatAt: new Date().toISOString()
        });
      });
    }, 5_000);
    heartbeat.unref();
    const wallTimer = setTimeout(
      () => stopChild("wall_time"),
      spec.resources.wallTimeSeconds * 1_000
    );
    wallTimer.unref();
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child!.once("error", reject);
        child!.once("exit", (code, signal) => resolve({ code, signal }));
      }
    );
    clearInterval(heartbeat);
    clearTimeout(wallTimer);
    const usage = child.pid ? await readProcessUsage(child.pid) : null;
    const completedAt = new Date().toISOString();
    await writeState({
      state:
        terminalReason === "cancelled"
          ? "cancelled"
          : outcome.code === 0
            ? "succeeded"
            : "failed",
      exitCode: outcome.code,
      failureCode:
        terminalReason === "wall_time"
          ? "WALL_TIME_EXCEEDED"
          : outcome.signal
            ? `SIGNAL_${outcome.signal}`
            : outcome.code === 0
              ? null
              : "PROCESS_EXIT_NONZERO",
      failureMessage:
        terminalReason === "wall_time"
          ? `Job exceeded ${spec.resources.wallTimeSeconds} seconds.`
          : null,
      completedAt,
      lastHeartbeatAt: completedAt,
      ...(usage ?? {}),
      peakMemoryKiB: Math.max(peakMemoryKiB, usage?.peakMemoryKiB ?? 0)
    });
  } catch (error) {
    const completedAt = new Date().toISOString();
    await writeState({
      state: terminalReason === "cancelled" ? "cancelled" : "failed",
      failureCode: "SUPERVISOR_ERROR",
      failureMessage: error instanceof Error ? error.message : String(error),
      completedAt,
      lastHeartbeatAt: completedAt
    });
    process.exitCode = 1;
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
