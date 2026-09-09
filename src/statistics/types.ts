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
  tokens: StatisticsTokens;
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
