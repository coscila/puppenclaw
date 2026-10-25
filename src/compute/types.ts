import { z } from "zod";

export const computeExecutorZod = z.enum([
  "bubblewrap-local",
  "rootless-docker",
  "slurm",
  "htcondor",
  "psij"
]);

export const computeResourcesZod = z.object({
  cpuCores: z.number().int().min(1).max(1024),
  memoryMiB: z.number().int().min(128),
  wallTimeSeconds: z.number().int().min(1),
  gpuCount: z.number().int().min(0).default(0),
  diskMiB: z.number().int().min(0).default(0)
});

export const computeJobSpecZod = z.object({
  jobId: z.string().regex(/^[A-Za-z0-9._-]{1,180}$/u),
  executor: computeExecutorZod,
  command: z.array(z.string().min(1)).min(1).max(256),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()).default({}),
  resources: computeResourcesZod,
  /** Optional owning chat session so detached jobs can be attributed to it. */
  sessionName: z.string().trim().min(1).max(200).optional(),
  /**
   * Optional run principal (P3) whose socket directory the launcher binds into
   * the sandbox. Only the authenticated submitter names it; the binding reaches
   * the host-side launcher through the controller environment, never the job's.
   */
  principalId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u).optional()
});

export const computeJobStateZod = z.enum([
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "orphaned"
]);

export const computeJobRecordZod = z.object({
  id: z.string(),
  state: computeJobStateZod,
  // Nullable with a default so legacy persisted payloads keep parsing.
  sessionName: z.string().nullable().default(null),
  executor: computeExecutorZod,
  command: z.array(z.string()),
  cwd: z.string(),
  resources: computeResourcesZod,
  supervisorPid: z.number().int().positive().nullable(),
  supervisorStartTicks: z.string().nullable(),
  childPid: z.number().int().positive().nullable(),
  childStartTicks: z.string().nullable(),
  stdoutPath: z.string().nullable(),
  stderrPath: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  submittedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  lastHeartbeatAt: z.string().nullable(),
  peakMemoryKiB: z.number().int().min(0).nullable(),
  cpuSeconds: z.number().min(0).nullable(),
  readBytes: z.number().int().min(0).nullable(),
  writeBytes: z.number().int().min(0).nullable()
});

export type ComputeJobSpec = z.infer<typeof computeJobSpecZod>;
export type ComputeJobRecord = z.infer<typeof computeJobRecordZod>;
export type ComputeJobState = z.infer<typeof computeJobStateZod>;

