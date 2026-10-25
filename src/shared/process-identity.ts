import { readFile } from "node:fs/promises";

/** The /proc/<pid>/stat fields the daemon uses to identify a process without trusting a bare PID. */
export type LinuxProcessStat = {
  pid: number;
  parentPid: number;
  processGroupId: number;
  sessionId: number;
  startTicks: string;
  /** `<pid>:<start ticks>`: unique for the lifetime of the boot. */
  processStartIdentity: string;
};

export async function readLinuxProcessStat(pid: number): Promise<LinuxProcessStat | null> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  const raw = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  if (raw == null) {
    return null;
  }
  const commandEnd = raw.lastIndexOf(")");
  if (commandEnd < 0) {
    return null;
  }
  // Fields after the command name, starting with field 3 (state).
  const fields = raw.slice(commandEnd + 1).trim().split(/\s+/u);
  const parentPid = Number.parseInt(fields[1] ?? "", 10);
  const processGroupId = Number.parseInt(fields[2] ?? "", 10);
  const sessionId = Number.parseInt(fields[3] ?? "", 10);
  const startTicks = fields[19];
  if (
    !Number.isFinite(parentPid) ||
    !Number.isFinite(processGroupId) ||
    !Number.isFinite(sessionId) ||
    startTicks == null ||
    !/^\d+$/u.test(startTicks)
  ) {
    return null;
  }
  return {
    pid,
    parentPid,
    processGroupId,
    sessionId,
    startTicks,
    processStartIdentity: `${pid}:${startTicks}`
  };
}

/** True while any process is a member of the group (or the check is not permitted). */
export function processGroupMayExist(processGroupId: number): boolean {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
