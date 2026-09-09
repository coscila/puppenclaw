import { describe, expect, it } from "vitest";
import { createTempDir } from "../helpers.js";
import { TurnStatisticsStore } from "../../src/statistics/store.js";
import { ProcessCpuCounter } from "../../src/statistics/proc-cpu.js";
import { statisticsTokens, unavailableTokens } from "../../src/statistics/tokens.js";
import type { RunnerTurnStatistics } from "../../src/statistics/types.js";
import type { ProcSnapshot } from "../../src/resources/proc.js";

function row(id: string): RunnerTurnStatistics {
  return { version: 1, id, revision: "0", chatId: "chat", attemptId: id, sessionName: "session", runnerTurnId: id, turnKey: id, agent: "claude", modelProviderId: null, model: null, state: "running", startedAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:01.000Z", finishedAt: null, activeElapsedMs: 1000, runtimeQuality: "measured", tokens: unavailableTokens(), cpu: { agentCpuMs: null, quality: "unavailable", sampleCount: 0, coverageReasons: [] }, coverageReasons: [] };
}
function procSnapshot(t: number, values: Array<[number, number, string, number]>): ProcSnapshot {
  return { sampledAtMs: t, uptimeSeconds: 200, hostCpu: null, memInfo: null, loadAvg: null, processes: new Map(values.map(([pid, ppid, startTicks, cpuTicks]) => [pid, { pid, ppid, startTicks, cpuTicks, name: "synthetic", rssBytes: 0 }])) };
}
describe("durable statistics foundations", () => {
  it("pages latest revisions without dropping updates and keeps identity across restart", async () => {
    const root = await createTempDir("statistics-store-");
    let store = await TurnStatisticsStore.open(root);
    const daemon = store.daemonId;
    store.put(row("a")); store.put(row("b"));
    const first = store.page("0", 1);
    expect(first.hasMore).toBe(true); expect(first.turns.map((v) => v.id)).toEqual(["a"]);
    store.put({ ...row("a"), activeElapsedMs: 2000 });
    expect(store.page(first.nextCursor).turns.map((v) => v.id)).toEqual(["b", "a"]);
    store.close(); store = await TurnStatisticsStore.open(root);
    expect(store.daemonId).toBe(daemon);
    store.recoverInterrupted();
    expect(store.get("a")).toMatchObject({ state: "interrupted", activeElapsedMs: 2000, finishedAt: "2026-09-09T00:00:01.000Z", runtimeQuality: "partial" });
    expect(() => store.page("-1")).toThrow(); expect(() => store.page("0", 501)).toThrow();
    store.close();
  });
  it("normalizes inclusive input and keeps cache/reasoning as subsets", () => {
    expect(statisticsTokens({ inputTokens: 10, outputTokens: 5, cachedReadTokens: 20, cachedWriteTokens: 3 }, "acp", true)).toMatchObject({ input: 33, output: 5, total: 38, cacheRead: 20, cacheWrite: 3, quality: "measured", reasoning: null });
    expect(statisticsTokens({ input_tokens: 33, output_tokens: 5, cached_input_tokens: 20, reasoning_output_tokens: 2 }, "codex", true)).toMatchObject({ input: 33, output: 5, total: 38, reasoning: 2, cacheRead: 20 });
    expect(statisticsTokens({ totalTokens: 80 }, "acp", true)).toMatchObject({ input: null, output: null, total: 80, quality: "partial" });
    expect(statisticsTokens({ inputTokens: -1, outputTokens: Infinity }, "acp", true)).toEqual(unavailableTokens());
  });
  it("measures new children, baselines existing roots, retains reparented children and rejects PID reuse", () => {
    const counter = new ProcessCpuCounter(100);
    counter.register({ pid: 1, startTicks: "50" });
    counter.sample(procSnapshot(0, [[1, 0, "50", 1000], [2, 1, "110", 20]]));
    expect(counter.cpuMs).toBe(200);
    counter.sample(procSnapshot(1000, [[1, 0, "50", 1010], [2, 0, "110", 30]]));
    expect(counter.cpuMs).toBe(400);
    counter.sample(procSnapshot(2000, [[1, 0, "999", 9000], [2, 0, "110", 40]]));
    expect(counter.cpuMs).toBe(500);
    expect(counter.coverageReasons.has("process_exit_between_samples")).toBe(true);
  });
  it("does not charge linked compute roots or unobserved processes as zero", () => {
    const counter = new ProcessCpuCounter(100);
    counter.register({ pid: 1, startTicks: "110" });
    counter.sample(procSnapshot(0, [[1, 0, "110", 5], [2, 1, "120", 100], [3, 2, "130", 100]]), new Set([2, 3]));
    expect(counter.cpuMs).toBe(50);
    expect(new ProcessCpuCounter(100).cpuMs).toBeNull();
  });
});
