import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ComputeJobRecord } from "../compute/types.js";
import {
  collectDescendants,
  readProcSnapshot,
  TICKS_PER_SECOND,
  type ProcSnapshot,
} from "../resources/proc.js";
import { PuppenclawError } from "../shared/errors.js";
import type { ModelUsageGroup } from "../shared/model-usage.js";
import type { SessionInfo } from "../shared/types.js";
import { ProcessCpuCounter, type VerifiedProcessRoot } from "./proc-cpu.js";
import { statisticsTokens, unavailableTokens } from "./tokens.js";
import { TurnStatisticsStore } from "./store.js";
import type {
  RunnerTurnModelStatistics,
  RunnerTurnStatistics,
  StatisticsContext,
  StatisticsState,
  StatisticsTokens,
} from "./types.js";

type Meter = {
  row: RunnerTurnStatistics;
  counter: ProcessCpuCounter | null;
  segmentStarted: number | null;
  elapsed: number;
  ended: boolean;
  pendingRoots: VerifiedProcessRoot[];
  settlement: Promise<void> | null;
  usageResults: Map<string, StatisticsTokens>;
  usageBridgeSeen: boolean;
  /** Set once a valid wrapper model-usage line arrived; it then owns the totals. */
  modelUsageSeen: boolean;
};
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
type TokenCountKey = Exclude<keyof StatisticsTokens, "quality">;
/** Field-wise sum; a field is null when any part lacks it or the sum is unsafe. */
function sumTokens(
  parts: readonly StatisticsTokens[],
  final: boolean,
): StatisticsTokens {
  const sum = (key: TokenCountKey): number | null => {
    const values = parts.map((item) => item[key]);
    if (values.some((value) => value === null)) return null;
    const total = values.reduce<number>((a, b) => a + b!, 0);
    return Number.isSafeInteger(total) ? total : null;
  };
  const input = sum("input");
  const output = sum("output");
  return {
    input,
    output,
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    reasoning: sum("reasoning"),
    total: sum("total"),
    quality:
      final &&
      input !== null &&
      output !== null &&
      parts.every((item) => item.quality === "measured")
        ? "measured"
        : "partial",
  };
}
export class TurnStatisticsRecorder {
  private readonly active = new Map<string, Meter>();
  private readonly sessionRoots = new Map<string, VerifiedProcessRoot[]>();
  private readonly processOwners = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> = Promise.resolve();
  constructor(
    readonly store: TurnStatisticsStore,
    private readonly deps: {
      listComputeJobs: () => ComputeJobRecord[] | Promise<ComputeJobRecord[]>;
      readSnapshot?: () => Promise<ProcSnapshot>;
      now?: () => number;
      warn?: (code: string) => void;
    },
  ) {}
  private clock(): number {
    return this.deps.now?.() ?? performance.now();
  }
  admit(
    context: StatisticsContext,
    session: {
      name: string;
      agent: string;
      model?: string | undefined;
      modelProviderId?: string | undefined;
    },
    turnKey: string | undefined,
  ): string {
    const id = createHash("sha256")
      .update(JSON.stringify([context.chatId, context.attemptId]))
      .digest("hex");
    if (this.store.get(id) !== null)
      throw new PuppenclawError(
        "STATISTICS_CONTEXT_REUSED",
        "A statistics attempt already has an execution record; replay its durable turn key.",
      );
    if (this.active.has(session.name))
      throw new PuppenclawError(
        "SESSION_BUSY",
        "A statistics turn is already active.",
      );
    const now = new Date().toISOString();
    const row = this.store.put({
      ...context,
      id,
      revision: "0",
      sessionName: session.name,
      runnerTurnId: `statistics-${id}`,
      turnKey: turnKey ?? null,
      agent: session.agent,
      modelProviderId: session.modelProviderId ?? null,
      model: session.model ?? null,
      state: "running",
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      activeElapsedMs: 0,
      runtimeQuality: "measured",
      tokens: unavailableTokens(),
      cpu: {
        agentCpuMs: null,
        quality: "unavailable",
        sampleCount: 0,
        coverageReasons: ["process_sampling"],
      },
      coverageReasons: [],
    });
    this.active.set(session.name, {
      row,
      counter: null,
      segmentStarted: null,
      elapsed: 0,
      ended: false,
      pendingRoots: [],
      settlement: null,
      usageResults: new Map(),
      usageBridgeSeen: false,
      modelUsageSeen: false,
    });
    return row.runnerTurnId;
  }
  async beginSegment(session: SessionInfo): Promise<void> {
    const meter = this.active.get(session.name);
    if (!meter || meter.ended) return;
    meter.row.model =
      session.model ?? session.modelProvider?.model ?? meter.row.model;
    meter.row.modelProviderId =
      session.modelProviderId ??
      session.modelProvider?.id ??
      meter.row.modelProviderId;
    if (meter.segmentStarted !== null) return;
    const snapshot = await this.snapshot().catch(() => null);
    if (!meter.counter && snapshot) {
      meter.counter = new ProcessCpuCounter(
        snapshot.uptimeSeconds > 0
          ? snapshot.uptimeSeconds * TICKS_PER_SECOND
          : Infinity,
      );
      if (snapshot.uptimeSeconds <= 0)
        meter.counter.coverageReasons.add("boot_clock_unavailable");
      for (const root of this.sessionRoots.get(session.name) ?? [])
        meter.counter.register(root);
      for (const root of meter.pendingRoots) meter.counter.register(root);
      this.sampleMeter(meter, snapshot, await this.computeExclusions(snapshot));
    }
    if (!snapshot) this.reason(meter, "proc_unavailable");
    if (meter.elapsed === 0) meter.row.startedAt = new Date().toISOString();
    meter.segmentStarted = this.clock();
    this.checkpoint(meter);
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.sample();
      }, 1000);
      this.timer.unref();
    }
  }
  registerRoot(name: string, root: VerifiedProcessRoot): void {
    const meter = this.active.get(name);
    if (!meter) return;
    meter.pendingRoots.push(root);
    meter.counter?.register(root);
    void this.sample();
  }
  observeEvent(name: string, raw: unknown, format: "acp" | "codex"): void {
    const meter = this.active.get(name);
    if (!meter || meter.ended) return;
    const event = record(raw);
    if (!event) return;
    let usage: unknown,
      final = false;
    if (format === "acp") {
      const result = record(event.result);
      if (
        result &&
        typeof result.stopReason === "string" &&
        record(result.usage)
      ) {
        usage = result.usage;
        final = true;
      }
      const update =
        record(record(event.params)?.update) ?? record(event.update) ?? event;
      if (
        typeof update.toolCallId === "string" &&
        update.toolCallId.startsWith("ocsl-workflow:")
      )
        this.reason(meter, "workflow_usage_coverage_unverified");
      const bridge = record(record(update._meta)?.ocslUsage);
      if (
        bridge?.version === 1 &&
        typeof bridge.eventId === "string" &&
        bridge.eventId.length > 0 &&
        bridge.eventId.length <= 200
      ) {
        meter.usageBridgeSeen = true;
        if (bridge.scope === "unattributed")
          this.reason(meter, "unattributed_autonomous_usage");
        else if (
          bridge.scope === "user" ||
          bridge.scope === "owned-autonomous"
        ) {
          const observed = statisticsTokens(bridge.usage, "anthropic", false);
          if (observed.quality !== "unavailable")
            meter.usageResults.set(bridge.eventId, observed);
        }
      }
    } else {
      // The wrapper's per-thread line owns the totals once it arrived: never
      // add or overwrite it with main-thread Codex usage (no double counting).
      if (meter.modelUsageSeen) return;
      if (event.type === "turn.completed") {
        usage = event.usage;
        final = true;
      } else if (event.type === "token_count") {
        // total_token_usage may include a resumed native session's prior turns.
        // Without a trusted baseline only last_token_usage is attributable.
        usage = record(event.info)?.last_token_usage;
        if (!usage) this.reason(meter, "cumulative_usage_without_baseline");
      }
    }
    if (meter.usageResults.size > 0) {
      // UUID-keyed SDK results are increments. The ACP completion repeats the
      // user aggregate, so it only supplies finality and is never added again.
      const sum = (key: TokenCountKey): number | null => {
        const values = [...meter.usageResults.values()].map(
          (item) => item[key],
        );
        if (values.some((value) => value === null)) return null;
        const total = values.reduce<number>((a, b) => a + b!, 0);
        return Number.isSafeInteger(total) ? total : null;
      };
      meter.row.tokens = {
        input: sum("input"),
        output: sum("output"),
        cacheRead: sum("cacheRead"),
        cacheWrite: sum("cacheWrite"),
        reasoning: sum("reasoning"),
        total: sum("total"),
        quality:
          final && sum("input") !== null && sum("output") !== null
            ? "measured"
            : "partial",
      };
    } else if (!meter.usageBridgeSeen && record(usage)) {
      const tokens = statisticsTokens(usage, format, final);
      if (tokens.quality !== "unavailable") meter.row.tokens = tokens;
    }
    if (
      meter.row.coverageReasons.some((reason) =>
        [
          "workflow_usage_coverage_unverified",
          "unattributed_autonomous_usage",
        ].includes(reason),
      ) &&
      meter.row.tokens.quality !== "unavailable"
    )
      meter.row.tokens.quality = "partial";
  }
  /**
   * Accepts the OCSL wrapper's per-thread usage (already validated and grouped).
   * The latest line wins; the turn total becomes the sum over its models, which
   * includes the main thread, so it replaces rather than adds to Codex usage.
   *
   * Subagents ran on the session's provider unless the session pinned them to
   * local model workers (`localWorkers`, from `modelProvider.subagents`): only
   * those carry a null provider id, which the consumer resolves to the preset
   * the policy pins them to.
   */
  observeModelUsage(
    name: string,
    groups: readonly ModelUsageGroup[],
    options: { localWorkers?: boolean } = {},
  ): void {
    const meter = this.active.get(name);
    if (!meter || meter.ended || groups.length === 0) return;
    const models: RunnerTurnModelStatistics[] = groups.map((group) => ({
      role: group.role,
      model: group.model,
      modelProviderId:
        group.role === "subagent" && options.localWorkers === true
          ? null
          : meter.row.modelProviderId,
      threads: group.threads,
      tokens: statisticsTokens(group.usage, "codex", true),
    }));
    if (models.some((model) => model.tokens.quality === "unavailable")) return;
    meter.modelUsageSeen = true;
    meter.row.models = models;
    meter.row.tokens = sumTokens(
      models.map((model) => model.tokens),
      true,
    );
    // The wrapper baselines resumed threads, so cumulative counters are no
    // longer an attribution gap for this turn.
    meter.row.coverageReasons = meter.row.coverageReasons.filter(
      (reason) => reason !== "cumulative_usage_without_baseline",
    );
  }
  private reason(meter: Meter, reason: string): void {
    if (!meter.row.coverageReasons.includes(reason))
      meter.row.coverageReasons.push(reason);
  }
  private snapshot(): Promise<ProcSnapshot> {
    return this.deps.readSnapshot?.() ?? readProcSnapshot();
  }
  private sampleMeter(
    meter: Meter,
    snapshot: ProcSnapshot,
    excluded: Set<number>,
  ): void {
    meter.counter?.sample(snapshot, excluded, (identity) => {
      const owner = this.processOwners.get(identity);
      if (owner !== undefined && owner !== meter.row.id) return false;
      this.processOwners.set(identity, meter.row.id);
      return true;
    });
  }
  private async computeExclusions(
    snapshot: ProcSnapshot,
  ): Promise<Set<number>> {
    const roots: number[] = [];
    for (const job of await this.deps.listComputeJobs()) {
      for (const [pid, ticks] of [
        [job.supervisorPid, job.supervisorStartTicks],
        [job.childPid, job.childStartTicks],
      ] as const)
        if (
          pid !== null &&
          ticks !== null &&
          snapshot.processes.get(pid)?.startTicks === ticks
        )
          roots.push(pid);
    }
    return collectDescendants(roots, snapshot.processes);
  }
  sample(): Promise<void> {
    const sample = async () => {
      if (
        ![...this.active.values()].some(
          (meter) => meter.segmentStarted !== null,
        )
      )
        return;
      const snapshot = await this.snapshot();
      const excluded = await this.computeExclusions(snapshot);
      for (const meter of this.active.values()) {
        if (meter.segmentStarted === null || meter.ended) continue;
        this.sampleMeter(meter, snapshot, excluded);
        this.checkpoint(meter);
      }
    };
    this.pending = this.pending.then(sample).catch(() => {
      for (const meter of this.active.values()) {
        this.reason(meter, "checkpoint_gap");
        meter.counter?.coverageReasons.add("checkpoint_gap");
        meter.row.runtimeQuality = "partial";
      }
      this.deps.warn?.("STATISTICS_CHECKPOINT_FAILED");
    });
    return this.pending;
  }
  private checkpoint(meter: Meter): void {
    meter.row.activeElapsedMs = Math.max(
      0,
      Math.round(
        meter.elapsed +
          (meter.segmentStarted === null
            ? 0
            : this.clock() - meter.segmentStarted),
      ),
    );
    meter.row.updatedAt = new Date().toISOString();
    if (meter.counter)
      meter.row.cpu = {
        agentCpuMs: meter.counter.cpuMs,
        quality: meter.counter.cpuMs === null ? "unavailable" : "partial",
        sampleCount: meter.counter.sampleCount,
        coverageReasons: [...meter.counter.coverageReasons],
      };
    meter.row = this.store.put(meter.row);
  }
  /** Called before the terminal runner receipt is persisted; publication never relies on SSE. */
  async settle(name: string, state: StatisticsState): Promise<void> {
    const meter = this.active.get(name);
    if (!meter) return;
    if (meter.settlement) return meter.settlement;
    if (meter.ended) return;
    meter.settlement = this.finishMeter(name, meter, state);
    return meter.settlement;
  }
  private async finishMeter(
    name: string,
    meter: Meter,
    state: StatisticsState,
  ): Promise<void> {
    const settledClock = this.clock();
    if (meter.segmentStarted !== null)
      meter.elapsed += Math.max(0, settledClock - meter.segmentStarted);
    meter.segmentStarted = null;
    await this.pending;
    try {
      const snapshot = await this.snapshot();
      this.sampleMeter(meter, snapshot, await this.computeExclusions(snapshot));
    } catch {
      this.reason(meter, "final_cpu_sample_unavailable");
      meter.counter?.coverageReasons.add("final_cpu_sample_unavailable");
    }
    meter.ended = true;
    meter.row.state = state;
    meter.row.finishedAt = new Date().toISOString();
    if (state !== "completed" && meter.row.tokens.quality !== "unavailable")
      meter.row.tokens.quality = "partial";
    if (state !== "completed")
      for (const model of meter.row.models ?? [])
        if (model.tokens.quality !== "unavailable")
          model.tokens.quality = "partial";
    this.checkpoint(meter);
    if (meter.counter)
      this.sessionRoots.set(name, meter.counter.rootsStillAlive());
    for (const [identity, owner] of this.processOwners)
      if (owner === meter.row.id) this.processOwners.delete(identity);
    this.active.delete(name);
    if (!this.active.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending;
    for (const name of [...this.active.keys()])
      await this.settle(name, "interrupted");
    this.store.close();
  }
  purgeChat(chatId: string): {
    version: 1;
    chatId: string;
    purged: true;
    removedTurns: number;
  } {
    if (
      [...this.active.values()].some((meter) => meter.row.chatId === chatId)
    ) {
      throw new PuppenclawError(
        "SESSION_BUSY",
        "A conversation turn is still active; verify runtime teardown before permanent statistics erasure.",
      );
    }
    return {
      version: 1,
      chatId,
      purged: true,
      removedTurns: this.store.purgeChat(chatId),
    };
  }
  forgetRuntime(sessionName: string): void {
    if (!this.active.has(sessionName)) this.sessionRoots.delete(sessionName);
  }
}
