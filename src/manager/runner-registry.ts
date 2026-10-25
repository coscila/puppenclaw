import type { ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  processGroupMayExist,
  readLinuxProcessStat
} from "../shared/process-identity.js";

/**
 * Durable registry of the detached process groups the daemon spawns (turn
 * runners and acpx control commands; every spawn sets `detached: true`, so each
 * child leads its own group). One small file per live group lives under
 * `<dataDir>/runners`; it is removed when the child closes. Files left behind
 * by a crashed daemon let the next boot find runner groups that outlived it.
 *
 * Boot reaper modes (`PUPPENCLAW_BOOT_REAPER`):
 * - `off`: no registry files, no boot scan (the behaviour before the registry).
 * - `observe` (default): track and report leftover groups at boot; signal nothing.
 * - `on`: terminate leftover groups whose leader is still the recorded process
 *   (pid plus /proc start ticks), SIGTERM first and SIGKILL after a grace period.
 *
 * A group whose leader is gone but which still has members is only reported:
 * its members cannot be proven to belong to the recorded group.
 */

export type RunnerKind = "turn" | "control";

export type BootReaperMode = "off" | "observe" | "on";

export type RunnerRecord = {
  version: 1;
  pid: number;
  processGroupId: number;
  processStartIdentity: string;
  kind: RunnerKind;
  sessionName: string;
  bootId: string;
  ownerPid: number;
  spawnedAt: string;
};

export type BootReapReport = {
  mode: BootReaperMode;
  /** Records left by earlier boots. */
  records: number;
  /** Groups already gone; their records were removed. */
  gone: number;
  /** Verified groups that were signalled and are gone. */
  terminated: number;
  /** Verified groups still alive (observe mode, or termination not proven). */
  survivors: number;
  /** Leader gone, group still populated: reported, never signalled. */
  unverified: number;
  /** Sessions whose turn runner group was terminated. */
  terminatedTurnSessions: string[];
};

const RUNNER_DIR = "runners";
const DEFAULT_TERMINATION_TIMEOUT_MS = 3_000;
const TERMINATION_POLL_MS = 50;

export function bootReaperModeFromEnv(env: NodeJS.ProcessEnv = process.env): BootReaperMode {
  const raw = env.PUPPENCLAW_BOOT_REAPER?.trim().toLowerCase();
  return raw === "off" || raw === "on" || raw === "observe" ? raw : "observe";
}

export function runnerRegistryDir(dataDir: string): string {
  return join(dataDir, RUNNER_DIR);
}

export class RunnerRegistry {
  private sequence = 0;
  private readonly live = new Map<string, RunnerKind>();

  private constructor(
    private readonly rootDir: string | null,
    readonly bootId: string,
    private readonly warn: (message: string) => void
  ) {}

  static async open(params: {
    dataDir: string;
    bootId: string;
    mode: BootReaperMode;
    warn?: (message: string) => void;
  }): Promise<RunnerRegistry> {
    const persist = params.mode !== "off" && process.platform === "linux";
    const rootDir = persist ? runnerRegistryDir(params.dataDir) : null;
    if (rootDir != null) {
      await mkdir(rootDir, { recursive: true, mode: 0o700 });
    }
    return new RunnerRegistry(rootDir, params.bootId, params.warn ?? (() => undefined));
  }

  /** In-memory registry for callers that do not persist (plugin mode, tests). */
  static memory(bootId = "memory"): RunnerRegistry {
    return new RunnerRegistry(null, bootId, () => undefined);
  }

  track(child: ChildProcess, meta: { kind: RunnerKind; sessionName?: string }): void {
    const pid = child.pid;
    if (pid == null) {
      return;
    }
    this.sequence += 1;
    const key = `${pid}.${this.sequence}`;
    this.live.set(key, meta.kind);
    const rootDir = this.rootDir;
    const persisted: Promise<string | null> =
      rootDir == null
        ? Promise.resolve(null)
        : (async () => {
            const stat = await readLinuxProcessStat(pid);
            if (stat == null) {
              return null;
            }
            const record: RunnerRecord = {
              version: 1,
              pid,
              processGroupId: stat.processGroupId,
              processStartIdentity: stat.processStartIdentity,
              kind: meta.kind,
              sessionName: meta.sessionName ?? "",
              bootId: this.bootId,
              ownerPid: process.pid,
              spawnedAt: new Date().toISOString()
            };
            const file = join(rootDir, `${key}.json`);
            await writeFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
            return file;
          })().catch((error: unknown) => {
            this.warn(
              `Runner registry write failed for pid ${pid}: ${error instanceof Error ? error.message : String(error)}`
            );
            return null;
          });
    child.once("close", () => {
      this.live.delete(key);
      void persisted.then((file) =>
        file == null ? undefined : unlink(file).catch(() => undefined)
      );
    });
  }

  counts(): { total: number; turn: number; control: number } {
    let turn = 0;
    let control = 0;
    for (const kind of this.live.values()) {
      if (kind === "turn") {
        turn += 1;
      } else {
        control += 1;
      }
    }
    return { total: turn + control, turn, control };
  }
}

function parseRecord(raw: string): RunnerRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<RunnerRecord>;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      !Number.isSafeInteger(value.processGroupId) ||
      typeof value.processStartIdentity !== "string" ||
      (value.kind !== "turn" && value.kind !== "control") ||
      typeof value.bootId !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      pid: value.pid as number,
      processGroupId: value.processGroupId as number,
      processStartIdentity: value.processStartIdentity,
      kind: value.kind,
      sessionName: typeof value.sessionName === "string" ? value.sessionName : "",
      bootId: value.bootId,
      ownerPid: Number.isSafeInteger(value.ownerPid) ? (value.ownerPid as number) : 0,
      spawnedAt: typeof value.spawnedAt === "string" ? value.spawnedAt : ""
    };
  } catch {
    return null;
  }
}

async function leaderMatches(record: RunnerRecord): Promise<boolean> {
  const stat = await readLinuxProcessStat(record.pid);
  return stat != null && stat.processStartIdentity === record.processStartIdentity;
}

function signalGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch {
    // The group is already gone.
  }
}

async function terminateVerifiedGroup(record: RunnerRecord, timeoutMs: number): Promise<boolean> {
  // Signal only while the recorded leader is provably alive: its pid then still
  // owns the group id, so the group cannot belong to another process.
  if (!(await leaderMatches(record))) {
    return !processGroupMayExist(record.processGroupId);
  }
  signalGroup(record.processGroupId, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  const escalateAt = Date.now() + Math.floor(timeoutMs / 2);
  let escalated = false;
  while (Date.now() < deadline) {
    if (!processGroupMayExist(record.processGroupId)) {
      return true;
    }
    if (!escalated && Date.now() >= escalateAt) {
      escalated = true;
      signalGroup(record.processGroupId, "SIGKILL");
    }
    await new Promise((resolve) => setTimeout(resolve, TERMINATION_POLL_MS));
  }
  return !processGroupMayExist(record.processGroupId);
}

/**
 * Scans the registry left by earlier boots. Must run after the session-state
 * owner lease is held (no other live daemon can own these records) and before
 * persisted sessions are reconciled.
 */
export async function reapRunnerGroups(params: {
  dataDir: string;
  bootId: string;
  mode: BootReaperMode;
  log?: (message: string) => void;
  terminationTimeoutMs?: number;
}): Promise<BootReapReport> {
  const report: BootReapReport = {
    mode: params.mode,
    records: 0,
    gone: 0,
    terminated: 0,
    survivors: 0,
    unverified: 0,
    terminatedTurnSessions: []
  };
  if (params.mode === "off" || process.platform !== "linux") {
    return report;
  }
  const log = params.log ?? (() => undefined);
  const rootDir = runnerRegistryDir(params.dataDir);
  const entries = await readdir(rootDir).catch(() => [] as string[]);
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const file = join(rootDir, entry);
    const record = parseRecord(await readFile(file, "utf8").catch(() => ""));
    if (record == null) {
      await unlink(file).catch(() => undefined);
      continue;
    }
    if (record.bootId === params.bootId) {
      continue;
    }
    report.records += 1;
    const leaderAlive = await leaderMatches(record);
    if (!leaderAlive && !processGroupMayExist(record.processGroupId)) {
      report.gone += 1;
      await unlink(file).catch(() => undefined);
      continue;
    }
    const label = `${record.kind} runner group ${record.processGroupId}${
      record.sessionName ? ` (session ${record.sessionName})` : ""
    } from boot ${record.bootId}`;
    if (!leaderAlive) {
      report.unverified += 1;
      log(`Boot reaper: ${label} lost its leader but still has members; not signalled.`);
      continue;
    }
    if (params.mode !== "on") {
      report.survivors += 1;
      log(`Boot reaper (observe): ${label} is still running.`);
      continue;
    }
    if (await terminateVerifiedGroup(record, params.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS)) {
      report.terminated += 1;
      if (record.kind === "turn" && record.sessionName) {
        report.terminatedTurnSessions.push(record.sessionName);
      }
      await unlink(file).catch(() => undefined);
      log(`Boot reaper: terminated ${label}.`);
    } else {
      report.survivors += 1;
      log(`Boot reaper: ${label} did not exit after SIGTERM and SIGKILL.`);
    }
  }
  if (report.records > 0) {
    log(
      `Boot reaper (${report.mode}): ${report.records} leftover runner group record(s); ` +
        `${report.gone} gone, ${report.terminated} terminated, ${report.survivors} running, ${report.unverified} unverified.`
    );
  }
  return report;
}

/**
 * Runner groups of earlier boots that are still alive now (GET /ops/idle).
 * The boot scan keeps the records of groups it left running (observe mode,
 * termination not proven, or a populated group without its leader); this
 * re-checks them on every call with the same rule, so a group that exits after
 * the boot stops counting at once. Records of exited groups stay on disk until
 * the next boot removes them. Reads only; never signals.
 */
export async function countLiveLeftoverRunnerGroups(params: {
  dataDir: string;
  bootId: string;
  mode: BootReaperMode;
}): Promise<number> {
  if (params.mode === "off" || process.platform !== "linux") {
    return 0;
  }
  const rootDir = runnerRegistryDir(params.dataDir);
  const entries = await readdir(rootDir).catch(() => [] as string[]);
  let live = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const record = parseRecord(await readFile(join(rootDir, entry), "utf8").catch(() => ""));
    if (record == null || record.bootId === params.bootId) {
      continue;
    }
    if ((await leaderMatches(record)) || processGroupMayExist(record.processGroupId)) {
      live += 1;
    }
  }
  return live;
}
