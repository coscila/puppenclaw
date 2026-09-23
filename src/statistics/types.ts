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
 * native threads grouped by (role, model). Entries carry the session's model
 * provider id, since subagents normally run on it too. The exception is
 * subagents of a session with a local subagent policy (`modelProvider.subagents`,
 * "use local model workers"). They ran on the pinned local model instead, so
 * their provider id is null and the consumer attributes them.
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
