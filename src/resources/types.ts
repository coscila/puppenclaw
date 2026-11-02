import { z } from "zod";

// ---------------------------------------------------------------------------
// Daemon API payloads. These field names are a frozen contract with the
// coscila web app (it builds against `response.details`). Do not rename.
// ---------------------------------------------------------------------------

/**
 * CPU conventions: per-process/per-session `cpuPct` is percent of one core
 * (can exceed 100, like `top`); host `cpuPct` is 0-100 machine-wide.
 * Timestamps are ISO strings at every API boundary (epoch-ms only in the DB).
 */
export type SessionProcessInfo = {
  pid: number;
  ppid: number;
  name: string;
  cpuPct: number;
  rssBytes: number;
  kind: "turn" | "compute";
};

export type ComputeJobRoots = {
  jobId: string;
  supervisorPid: number | null;
  childPid: number | null;
};

export type ResourceTotals = {
  cpuPct: number;
  rssBytes: number;
  processCount: number;
};

export type SessionProcessesPayload = {
  name: string;
  sampledAt: string;
  sampleWindowMs: number;
  supported: boolean;
  roots: {
    turnPid: number | null;
    computeJobs: ComputeJobRoots[];
  };
  /** Sorted cpuPct descending. */
  processes: SessionProcessInfo[];
  totals: ResourceTotals;
};

export type HostSnapshot = {
  /** 0-100 machine-wide. */
  cpuPct: number;
  cpuCount: number;
  memTotalBytes: number;
  memAvailableBytes: number;
  load1: number;
  load5: number;
  load15: number;
};

export type SessionUsageSnapshot = {
  name: string;
  state: string;
  cpuPct: number;
  rssBytes: number;
  processCount: number;
  computeJobCount: number;
};

export type UnlinkedComputeSnapshot = {
  jobCount: number;
  cpuPct: number;
  rssBytes: number;
  processCount: number;
};

export type ResourcesSnapshotPayload = {
  sampledAt: string;
  samplingIntervalMs: number;
  supported: boolean;
  host: HostSnapshot | null;
  /** All sessions, zeros when idle. */
  sessions: SessionUsageSnapshot[];
  unlinkedCompute: UnlinkedComputeSnapshot;
  totals: ResourceTotals;
};

export type TopProcessSummary = {
  name: string;
  cpuPct: number;
  rssBytes: number;
};

export type SessionSeriesPoint = {
  ts: string;
  avgCpuPct: number;
  maxCpuPct: number;
  avgRssBytes: number;
  maxRssBytes: number;
  maxProcessCount: number;
  samples: number;
  topProcesses: TopProcessSummary[];
};

export type SessionSeries = {
  /** Empty string for the kind:"unlinked" series. */
  name: string;
  kind: "session" | "unlinked";
  points: SessionSeriesPoint[];
};

export type HostSeriesPoint = {
  ts: string;
  avgCpuPct: number;
  maxCpuPct: number;
  avgMemUsedBytes: number;
  memTotalBytes: number;
  avgLoad1: number;
  samples: number;
};

export type TotalsSeriesPoint = {
  ts: string;
  avgCpuPct: number;
  maxCpuPct: number;
  avgRssBytes: number;
  maxRssBytes: number;
  maxProcessCount: number;
  samples: number;
};

export type ResourcesHistoryPayload = {
  since: string;
  until: string;
  bucketSeconds: number;
  samplingIntervalMs: number;
  retentionDays: number;
  sessions: SessionSeries[];
  host: HostSeriesPoint[];
  totals: TotalsSeriesPoint[];
};

export const resourcesHistoryParamsZod = z
  .object({
    /** ISO timestamp; defaults to `until` minus 24 hours. */
    since: z.string().min(1).optional(),
    /** ISO timestamp; defaults to now. */
    until: z.string().min(1).optional(),
    /** Bucket width; defaults to at most ~500 points per series. */
    bucketSeconds: z
      .number()
      .int()
      .min(30)
      .max(86_400)
      .optional(),
    /** Restrict the per-session series to this session name. */
    session: z.string().min(1).optional()
  })
  .strict();

export type ResourcesHistoryParams = z.infer<typeof resourcesHistoryParamsZod>;
