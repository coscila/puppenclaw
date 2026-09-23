export type StatisticsContext = {
  version: 1;
  chatId: string;
  attemptId: string;
};
export type StatisticsState =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type StatisticsTokens = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  total: number | null;
  quality: "measured" | "partial" | "unavailable";
};
/**
 * Per-model split of one turn from the OCSL wrapper's `ocsl.model_usage` line:
 * native threads grouped by (role, model). The main orchestrator carries the
 * session's model provider id; subagents are attributed by the consumer.
 */
export type RunnerTurnModelStatistics = {
  role: "main" | "subagent";
  model: string;
  modelProviderId: string | null;
  threads: number;
  tokens: StatisticsTokens;
};
export type RunnerTurnStatistics = StatisticsContext & {
  id: string;
  revision: string;
  sessionName: string;
  runnerTurnId: string;
  turnKey: string | null;
  agent: string;
  modelProviderId: string | null;
  model: string | null;
  state: StatisticsState;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  activeElapsedMs: number;
  runtimeQuality: "measured" | "partial";
  /** When `models` is present this is the sum over it (all threads of the turn). */
  tokens: StatisticsTokens;
  /** Only present when the wrapper reported per-thread usage for the turn. */
  models?: RunnerTurnModelStatistics[];
  cpu: {
    agentCpuMs: number | null;
    quality: "partial" | "unavailable";
    sampleCount: number;
    coverageReasons: string[];
  };
  coverageReasons: string[];
};
export type StatisticsPage = {
  version: 1;
  daemonId: string;
  nextCursor: string;
  hasMore: boolean;
  turns: RunnerTurnStatistics[];
};
