import { z } from "zod";
import type { AdvancedOrchestration, InteractionMode, ModelProviderConfig, PermissionMode, SessionInfo, StartParams, ToolResult } from "../shared/types.js";
import type { StatisticsTokens } from "../statistics/types.js";

export const agentSubmitZod = z.object({ configId: z.string().min(1), idempotencyKey: z.string().min(1).max(128), task: z.string().min(1) }).strict();
export const bulkSubmitZod = z.object({
  configId: z.string().min(1), idempotencyKey: z.string().min(1).max(128),
  items: z.array(z.object({ id: z.string().min(1).max(200), input: z.union([z.string(), z.record(z.string(), z.unknown())]) }).strict()).min(1),
  schema: z.record(z.string(), z.unknown()).optional(), concurrency: z.number().int().positive().safe().default(60),
}).strict().refine((r) => new Set(r.items.map((x) => x.id)).size === r.items.length, "Item ids must be unique.");
export type AgentSubmit = z.infer<typeof agentSubmitZod>;
export type BulkSubmit = z.infer<typeof bulkSubmitZod>;
export type JobState = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "interrupted";
export type WorkerConfig = AdvancedOrchestration["workers"][number];
export type ItemResult = { id: string; state: JobState; output?: unknown; providerId: string; model: string; promptSha256: string; inputSha256?: string; usage: StatisticsTokens | null; receiptDigests?: { requestId: string; model: string; promptSha256: string }[]; error?: string };
export type WorkerJob = {
  jobId: string; kind: "agent" | "bulk"; state: JobState; parentSessionName: string; attemptId: string; ownerKey?: string;
  configRevision: number; config: WorkerConfig; idempotencyKey: string; fingerprint: string; createdAt: string; updatedAt: string;
  request: AgentSubmit | BulkSubmit; childSessionName?: string; resumedFromJobId?: string; results: ItemResult[]; error?: string;
};
export type UsageReceipt = {
  version: 1; requestId: string; parentSessionName: string; sessionName: string; attemptId: string; jobId?: string; itemId?: string; ownerKey?: string;
  providerId: string; model: string; role: "main" | "subagent"; promptSha256: string;
  httpStatus?: number; errorCode?: string; authTransport?: "authorization" | "api-key" | "missing";
  state: "running" | "completed" | "failed" | "cancelled" | "interrupted"; usage: StatisticsTokens; createdAt: string; updatedAt: string;
};
export type RuntimeParticipant = {
  sessionName: string; parentSessionName: string; attemptId: string; directory: string; provider: ModelProviderConfig;
  ownerKey?: string; permissionMode: PermissionMode; interactionMode: InteractionMode; config: AdvancedOrchestration;
  jobId?: string; admissionOpen: boolean;
};
export type RuntimeDriver = {
  start: (params: StartParams) => Promise<ToolResult>;
  quiesce: (name: string) => Promise<void>;
  purge?: (name: string) => Promise<void>;
  getSession: (name: string) => SessionInfo | null;
  getOwner?: (name: string) => string | undefined;
  contribution: (receipt: UsageReceipt) => void;
  registerChild?: (parent: string, child: string) => void;
};
