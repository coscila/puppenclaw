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
  let childClosed = false;
  let childOutcome: Promise<{ code: number | null; signal: NodeJS.Signals | null; error: Error | null }> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTask: Promise<void> = Promise.resolve();
  let heartbeatBusy = false;
  let heartbeatError: unknown = null;
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
  let stateWrites: Promise<void> = Promise.resolve();
  const writeState = (patch: Partial<ComputeJobRecord>) => {
    state = computeJobRecordZod.parse({ ...state, ...patch });
    const next = state;
    const pending = stateWrites.catch(() => {}).then(() => writeJsonFileAtomic(statePath, next));
    stateWrites = pending;
    return pending;
  };
  await writeState({});

  const signalChild = () => {
    if (childClosed) return;
    child?.kill("SIGTERM");
    if (!killTimer) {
      killTimer = setTimeout(() => { if (!childClosed) child?.kill("SIGKILL"); }, 5_000);
      killTimer.unref();
    }
  };
  const stopChild = (reason: "cancelled" | "wall_time") => {
    terminalReason = reason;
    signalChild();
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
    // Observe even an immediate spawn failure before doing any awaited I/O.
    childOutcome = new Promise((resolve) => {
      let error: Error | null = null;
      child!.once("error", (failure) => { error = failure; });
      child!.once("close", (code, signal) => {
        childClosed = true;
        resolve({ code, signal, error });
      });
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
    heartbeat = setInterval(() => {
      if (!child?.pid || heartbeatBusy || childClosed) return;
      heartbeatBusy = true;
      heartbeatTask = readProcessUsage(child.pid).then((usage) => {
        peakMemoryKiB = Math.max(peakMemoryKiB, usage.peakMemoryKiB ?? 0);
        return writeState({
          ...usage,
          peakMemoryKiB,
          lastHeartbeatAt: new Date().toISOString()
        });
      }).catch((error) => {
        heartbeatError = error;
        signalChild();
      }).finally(() => { heartbeatBusy = false; });
    }, 5_000);
    heartbeat.unref();
    wallTimer = setTimeout(
      () => stopChild("wall_time"),
      spec.resources.wallTimeSeconds * 1_000
    );
    wallTimer.unref();
    const outcome = await childOutcome;
    clearInterval(heartbeat);
    clearTimeout(wallTimer);
    await heartbeatTask;
    if (outcome.error) throw outcome.error;
    if (heartbeatError) throw heartbeatError;
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
    clearInterval(heartbeat);
    clearTimeout(wallTimer);
    signalChild();
    // A controller/storage error is not proof that its spawned reader stopped.
    // Never publish a terminal record until the launcher has closed; retain an
    // orphaned reservation if even forced termination cannot be established.
    let quiet = !child || childClosed;
    if (!quiet && childOutcome) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      quiet = await Promise.race([
        childOutcome.then(() => true),
        new Promise<boolean>((resolve) => { deadline = setTimeout(() => resolve(false), 6_000); }),
      ]);
      clearTimeout(deadline);
    }
    await heartbeatTask;
    const completedAt = new Date().toISOString();
    await writeState({
      state: quiet ? (terminalReason === "cancelled" ? "cancelled" : "failed") : "orphaned",
      failureCode: quiet ? "SUPERVISOR_ERROR" : "SUPERVISOR_CLEANUP_UNPROVEN",
      failureMessage: error instanceof Error ? error.message : String(error),
      completedAt: quiet ? completedAt : null,
      lastHeartbeatAt: completedAt
    });
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(wallTimer);
    clearTimeout(killTimer);
    await Promise.all([stdout.close(), stderr.close()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
