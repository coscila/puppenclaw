import type { AdvancedStore, ArchiveReport } from "./store.js";

/**
 * Opt-in maintenance of advanced.sqlite; both tasks are off unless configured.
 * - PUPPENCLAW_ADVANCED_ARCHIVE_DAYS (an integer of at least 30): once a day,
 *   terminal jobs last updated more than that many days ago move to a verified
 *   archive file (counts and sha256 checked before the live rows go). Only jobs
 *   written by P1 with every event acknowledged qualify; jobs from before P1,
 *   jobs of a run principal, jobs with a study reference and jobs with a pending
 *   erasure stay.
 * - PUPPENCLAW_EVENT_RETENTION_DAYS (an integer of at least 7): once an hour,
 *   acknowledged outbox rows older than that are deleted. Rows after the
 *   acknowledged cursor are never deleted.
 */
export type AdvancedMaintenanceOptions = { archiveAfterDays: number | null; eventRetentionDays: number | null };

const DAY_MS = 24 * 60 * 60_000;

function days(env: NodeJS.ProcessEnv, name: string, minimum: number): number | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw.trim()) || !Number.isSafeInteger(value) || value < minimum || value > 36_500) throw new Error(`${name} must be an integer number of days from ${minimum} to 36500.`);
  return value;
}

export function maintenanceFromEnvironment(env: NodeJS.ProcessEnv = process.env): AdvancedMaintenanceOptions {
  return { archiveAfterDays: days(env, "PUPPENCLAW_ADVANCED_ARCHIVE_DAYS", 30), eventRetentionDays: days(env, "PUPPENCLAW_EVENT_RETENTION_DAYS", 7) };
}

export class AdvancedMaintenance {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private running: Promise<unknown> | undefined;
  private stopped = false;

  constructor(
    private readonly store: AdvancedStore,
    private readonly options: AdvancedMaintenanceOptions,
    private readonly log: (message: string) => void,
    private readonly now: () => number = Date.now
  ) {}

  start(): void {
    if (this.options.eventRetentionDays !== null) this.every(60 * 60_000, 60_000, () => this.prune());
    if (this.options.archiveAfterDays !== null) this.every(DAY_MS, 10 * 60_000, () => this.archive());
  }

  /** Deletes acknowledged events older than the retention; returns how many. */
  prune(): number {
    if (this.options.eventRetentionDays === null) return 0;
    const removed = this.store.pruneAcknowledged(new Date(this.now() - this.options.eventRetentionDays * DAY_MS));
    if (removed > 0) this.log(`ADVANCED_EVENTS_PRUNED ${removed}`);
    return removed;
  }

  /** Archives eligible terminal jobs in steps of at most 50 jobs. */
  async archive(): Promise<ArchiveReport | null> {
    if (this.options.archiveAfterDays === null) return null;
    const report = await this.store.archive({ before: new Date(this.now() - this.options.archiveAfterDays * DAY_MS), maxJobs: 50 });
    if (report.jobs > 0) this.log(`ADVANCED_ARCHIVED jobs=${report.jobs} items=${report.items} receipts=${report.receipts} file=${report.file} kept: historical=${report.skipped.historical} run=${report.skipped.run} study=${report.skipped.studyRef} unacknowledged=${report.skipped.unacknowledged}`);
    return report;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await this.running?.catch(() => undefined);
  }

  private every(intervalMs: number, firstMs: number, task: () => unknown): void {
    const run = () => {
      if (this.stopped) return;
      this.running = Promise.resolve().then(task).catch((error: unknown) => this.log(`ADVANCED_MAINTENANCE_FAILED ${error instanceof Error ? error.message : String(error)}`));
      void this.running.finally(() => { if (!this.stopped) schedule(intervalMs); });
    };
    const schedule = (delay: number) => {
      const timer = setTimeout(() => { this.timers.delete(timer); run(); }, delay);
      timer.unref?.(); this.timers.add(timer);
    };
    schedule(firstMs);
  }
}
