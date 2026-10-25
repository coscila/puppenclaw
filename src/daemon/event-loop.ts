import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/**
 * Event-loop delay over a rolling window, from perf_hooks.monitorEventLoopDelay.
 * The histogram records the full interval between timer ticks, so the
 * configured resolution is subtracted: the reported values are the lag beyond
 * the expected tick. The previous full window is kept so a fresh window with
 * few samples does not hide a recent stall.
 */
export type EventLoopSnapshot = {
  p99Ms: number;
  maxMs: number;
  windowMs: number;
};

const MIN_SAMPLES = 50;

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export class EventLoopMonitor {
  private histogram: IntervalHistogram | null = null;
  private timer: NodeJS.Timeout | null = null;
  private previous: { p99Ms: number; maxMs: number } | null = null;

  constructor(
    private readonly options: { resolutionMs?: number; windowMs?: number } = {}
  ) {}

  private get resolutionMs(): number {
    return this.options.resolutionMs ?? 10;
  }

  get windowMs(): number {
    return this.options.windowMs ?? 30_000;
  }

  start(): void {
    if (this.histogram != null) {
      return;
    }
    this.histogram = monitorEventLoopDelay({ resolution: this.resolutionMs });
    this.histogram.enable();
    this.timer = setInterval(() => this.rotate(), this.windowMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.histogram?.disable();
    this.histogram = null;
  }

  /** Closes the current window. Exposed for tests. */
  rotate(): void {
    const current = this.read();
    if (current != null) {
      this.previous = current;
    }
    this.histogram?.reset();
  }

  private read(): { p99Ms: number; maxMs: number } | null {
    const histogram = this.histogram;
    if (histogram == null || histogram.count < MIN_SAMPLES) {
      return null;
    }
    return {
      p99Ms: Math.max(0, histogram.percentile(99) / 1e6 - this.resolutionMs),
      maxMs: Math.max(0, histogram.max / 1e6 - this.resolutionMs)
    };
  }

  snapshot(): EventLoopSnapshot {
    const current = this.read();
    const previous = this.previous;
    const p99Ms = Math.max(current?.p99Ms ?? 0, previous?.p99Ms ?? 0);
    const maxMs = Math.max(current?.maxMs ?? 0, previous?.maxMs ?? 0);
    return { p99Ms: round(p99Ms), maxMs: round(maxMs), windowMs: this.windowMs };
  }
}
