import { collectDescendants, processIdentityKey, TICKS_PER_SECOND, type ProcSnapshot } from "../resources/proc.js";

export type VerifiedProcessRoot = { pid: number; startTicks: string };
/** Measured kernel-counter deltas only: never multiply an averaged CPU percentage. */
export class ProcessCpuCounter {
  private readonly roots = new Map<number, string>();
  private readonly observed = new Map<string, { pid: number; startTicks: string; ticks: number }>();
  private readonly retained = new Map<string, VerifiedProcessRoot>();
  readonly coverageReasons = new Set<string>(["process_sampling"]);
  private ticks = 0;
  private lastSampleMs: number | null = null;
  sampleCount = 0;
  constructor(private readonly startBootTicks: number) {}
  register(root: VerifiedProcessRoot): void { this.roots.set(root.pid, root.startTicks); }
  sample(snapshot: ProcSnapshot, excluded = new Set<number>()): void {
    if (this.lastSampleMs !== null && snapshot.sampledAtMs - this.lastSampleMs > 2500) this.coverageReasons.add("sampling_gap");
    this.lastSampleMs = snapshot.sampledAtMs;
    const liveRoots = [...this.roots].filter(([pid, ticks]) => snapshot.processes.get(pid)?.startTicks === ticks).map(([pid]) => pid);
    for (const value of this.retained.values()) if (snapshot.processes.get(value.pid)?.startTicks === value.startTicks) liveRoots.push(value.pid);
    const members = collectDescendants(liveRoots, snapshot.processes);
    let observedAny = false;
    for (const pid of members) {
      if (excluded.has(pid)) continue;
      const proc = snapshot.processes.get(pid)!;
      const key = processIdentityKey(pid, proc.startTicks);
      const previous = this.observed.get(key);
      if (previous) this.ticks += Math.max(0, proc.cpuTicks - previous.ticks);
      else if (Number(proc.startTicks) >= this.startBootTicks) this.ticks += Math.max(0, proc.cpuTicks);
      else this.coverageReasons.add("preexisting_process_baseline");
      this.observed.set(key, { pid, startTicks: proc.startTicks, ticks: proc.cpuTicks });
      this.retained.set(key, { pid, startTicks: proc.startTicks });
      observedAny = true;
    }
    for (const [key, proc] of this.retained) {
      if (snapshot.processes.get(proc.pid)?.startTicks !== proc.startTicks) {
        this.coverageReasons.add("process_exit_between_samples");
        this.retained.delete(key);
      } else if (excluded.has(proc.pid)) {
        this.retained.delete(key); this.observed.delete(key);
      }
    }
    if (observedAny) this.sampleCount++;
  }
  rootsStillAlive(): VerifiedProcessRoot[] { return [...this.retained.values()]; }
  get cpuMs(): number | null { return this.sampleCount ? Math.round(this.ticks * 1000 / TICKS_PER_SECOND) : null; }
}
