import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PAGE_SIZE_BYTES,
  collectDescendants,
  diffHostCpu,
  diffProcessCpu,
  parseHostCpu,
  parseLoadAvg,
  parseMemInfo,
  parseProcPidStat,
  parseUptimeSeconds,
  processIdentityKey,
  readProcSnapshot,
  type ProcProcess
} from "../../src/resources/proc.js";
import { writeFakeProc } from "../fixtures/fake-proc.js";
import { createTempDir } from "../helpers.js";

function proc(overrides: Partial<ProcProcess> & { pid: number }): ProcProcess {
  return {
    ppid: 0,
    name: `proc-${overrides.pid}`,
    startTicks: "1000",
    cpuTicks: 0,
    rssBytes: 0,
    ...overrides
  };
}

describe("resource proc primitives", () => {
  it("parses /proc/[pid]/stat including comm names with spaces and parentheses", () => {
    const raw = "42 (my (we)ird comm) S 7 42 42 0 -1 0 0 0 0 0 150 50 0 0 20 0 1 0 5000 1000000 250 0\n";
    const parsed = parseProcPidStat(42, raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("my (we)ird comm");
    expect(parsed?.ppid).toBe(7);
    expect(parsed?.startTicks).toBe("5000");
    expect(parsed?.cpuTicks).toBe(200);
    expect(parsed?.rssBytes).toBe(250 * PAGE_SIZE_BYTES);
  });

  it("rejects malformed stat lines", () => {
    expect(parseProcPidStat(1, "not a stat line")).toBeNull();
    expect(parseProcPidStat(1, "")).toBeNull();
  });

  it("reads a fake proc root and skips vanished or non-numeric entries", async () => {
    const procRoot = join(await createTempDir("puppenclaw-proc-"), "proc");
    await writeFakeProc(procRoot, [
      { pid: 10, ppid: 1, comm: "root-a", startTicks: 100, utime: 10, rssPages: 5 },
      { pid: 11, ppid: 10, comm: "child-a", startTicks: 110, stime: 20, rssPages: 3 }
    ]);
    // Vanished mid-sample: a pid directory without a readable stat file.
    await mkdir(join(procRoot, "999"), { recursive: true });
    // Non-numeric entries are not treated as pids.
    await writeFile(join(procRoot, "self"), "ignored", "utf8");

    const snapshot = await readProcSnapshot(procRoot);
    expect([...snapshot.processes.keys()].sort((a, b) => a - b)).toEqual([10, 11]);
    expect(snapshot.processes.get(10)?.name).toBe("root-a");
    expect(snapshot.processes.get(11)?.cpuTicks).toBe(20);
    expect(snapshot.uptimeSeconds).toBe(1000);
    expect(snapshot.hostCpu?.cpuCount).toBe(4);
    expect(snapshot.memInfo?.memTotalBytes).toBe(16_000_000 * 1024);
    expect(snapshot.loadAvg?.load1).toBe(0.5);
  });

  it("walks ancestry only and never merges unrelated trees sharing a pgrp", () => {
    // Process groups can collide: both trees share pgrp 100, but tree B is
    // NOT a descendant of tree A's root and must stay out.
    const processes = new Map<number, ProcProcess>();
    for (const entry of [
      proc({ pid: 100, ppid: 1 }),
      proc({ pid: 101, ppid: 100 }),
      proc({ pid: 102, ppid: 101 }),
      proc({ pid: 200, ppid: 1 }),
      proc({ pid: 201, ppid: 200 })
    ]) {
      processes.set(entry.pid, entry);
    }
    const members = collectDescendants([100], processes);
    expect([...members].sort((a, b) => a - b)).toEqual([100, 101, 102]);
    expect(members.has(200)).toBe(false);
    expect(members.has(201)).toBe(false);
  });

  it("drops roots that are not present in the snapshot", () => {
    const processes = new Map<number, ProcProcess>([[10, proc({ pid: 10, ppid: 1 })]]);
    expect([...collectDescendants([999], processes)]).toEqual([]);
  });

  it("computes interval-average cpu from cumulative jiffies deltas", () => {
    const current = proc({ pid: 5, cpuTicks: 1200, startTicks: "0" });
    // 200 ticks over 2s at 100 ticks/s => one full core.
    expect(
      diffProcessCpu({ process: current, prevCpuTicks: 1000, elapsedSeconds: 2, uptimeSeconds: 500 })
    ).toBe(100);
    expect(
      diffProcessCpu({ process: current, prevCpuTicks: 1100, elapsedSeconds: 2, uptimeSeconds: 500 })
    ).toBe(50);
  });

  it("falls back to the lifetime average for first-seen processes", () => {
    // Started at 5000 ticks (=50s after boot); uptime 100s => 50s alive.
    // 500 cumulative ticks over 50s => 10% of one core.
    const current = proc({ pid: 6, cpuTicks: 500, startTicks: "5000" });
    expect(
      diffProcessCpu({ process: current, prevCpuTicks: null, elapsedSeconds: null, uptimeSeconds: 100 })
    ).toBe(10);
  });

  it("treats a reused pid (different start ticks) as first-seen via the identity key", () => {
    const before = proc({ pid: 7, cpuTicks: 90_000, startTicks: "100" });
    const after = proc({ pid: 7, cpuTicks: 100, startTicks: "9000" });
    const prev = new Map<string, number>([
      [processIdentityKey(before.pid, before.startTicks), before.cpuTicks]
    ]);
    expect(processIdentityKey(after.pid, after.startTicks)).not.toBe(
      processIdentityKey(before.pid, before.startTicks)
    );
    const prevTicks = prev.get(processIdentityKey(after.pid, after.startTicks)) ?? null;
    expect(prevTicks).toBeNull();
    // Lifetime fallback: alive 100s - 90s = 10s, 100 ticks => 10%.
    expect(
      diffProcessCpu({ process: after, prevCpuTicks: prevTicks, elapsedSeconds: 30, uptimeSeconds: 100 })
    ).toBe(10);
  });

  it("parses the host cpu line and computes machine-wide cpu percent", () => {
    const first = parseHostCpu("cpu  1000 0 1000 8000 0 0 0 0\ncpu0 250 0 250 2000 0 0 0 0\ncpu1 250 0 250 2000 0 0 0 0\n");
    const second = parseHostCpu("cpu  1400 0 1200 8400 0 0 0 0\ncpu0 350 0 300 2100 0 0 0 0\ncpu1 350 0 300 2100 0 0 0 0\n");
    expect(first?.cpuCount).toBe(2);
    expect(first?.totalTicks).toBe(10_000);
    expect(first?.idleTicks).toBe(8_000);
    // delta total 1000, delta idle 400 => 60% busy.
    expect(diffHostCpu(first!, second!)).toBe(60);
  });

  it("parses meminfo, loadavg, and uptime", () => {
    const mem = parseMemInfo("MemTotal:       1000 kB\nMemFree:        100 kB\nMemAvailable:   400 kB\n");
    expect(mem).toEqual({ memTotalBytes: 1_024_000, memAvailableBytes: 409_600 });
    expect(parseLoadAvg("1.25 0.75 0.50 2/300 12345\n")).toEqual({
      load1: 1.25,
      load5: 0.75,
      load15: 0.5
    });
    expect(parseUptimeSeconds("123.45 400.00\n")).toBe(123.45);
    expect(parseMemInfo("garbage")).toBeNull();
    expect(parseLoadAvg("garbage")).toBeNull();
  });
});
