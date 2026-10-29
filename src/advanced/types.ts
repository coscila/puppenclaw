import { z } from "zod";
import type { AdvancedOrchestration, InteractionMode, ModelProviderConfig, PermissionMode, SessionInfo, StartParams, ToolResult } from "../shared/types.js";
import type { StatisticsTokens } from "../statistics/types.js";

export const agentSubmitZod = z.object({ configId: z.string().min(1), idempotencyKey: z.string().min(1).max(128), task: z.string().min(1) }).strict();
/** Opaque instrument digest installed through PUT /v2/instruments/{digest}; never recomputed by the daemon. */
export const instrumentDigestZod = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, "Instrument digests are 1-128 characters of [A-Za-z0-9._:-].");
export const bulkSubmitZod = z.object({
  configId: z.string().min(1), idempotencyKey: z.string().min(1).max(128),
  items: z.array(z.object({ id: z.string().min(1).max(200), input: z.union([z.string(), z.record(z.string(), z.unknown())]) }).strict()).min(1),
  schema: z.record(z.string(), z.unknown()).optional(), concurrency: z.number().int().positive().safe().default(60),
  /**
   * Instrument mode (capability instrumentMode): request settings come from the installed bundle. A verbatim
   * bundle (capability instrumentVerbatim) takes each item's messages as the executor built them, system message included.
   */
  instrumentDigest: instrumentDigestZod.optional(),
}).strict().refine((r) => new Set(r.items.map((x) => x.id)).size === r.items.length, "Item ids must be unique.");
export type AgentSubmit = z.infer<typeof agentSubmitZod>;
export type BulkSubmit = z.infer<typeof bulkSubmitZod>;
export type JobState = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "interrupted";
export type WorkerConfig = AdvancedOrchestration["workers"][number];
export type ItemResult = { id: string; state: JobState; output?: unknown; providerId: string; model: string; promptSha256: string; inputSha256?: string; usage: StatisticsTokens | null; receiptDigests?: { requestId: string; model: string; promptSha256: string }[]; error?: string;
  /** Provider calls made for this item (retries included). */
  attempts?: number;
  /** The provider stopped at the output-token limit (finish_reason=length). */
  truncated?: boolean; finishReason?: string | null;
  serverFingerprint?: string; settingsSha256?: string; outputDigest?: string; outputBytes?: number;
  /** sha256 of the canonical JSON of the request body the settling call sent upstream (see UsageReceipt). */
  requestSha256?: string;
  /**
   * Verbatim instrument calls only, as the upstream answered the settling call: the model its response named (null
   * when it named none; `model` then still holds the requested model), its system_fingerprint (null when it offered
   * none; `serverFingerprint` then holds the daemon's synthesized identity) and the HTTP status.
   */
  servedModel?: string | null; systemFingerprint?: string | null; httpStatus?: number;
  /** Closed failure code of a settled item, e.g. PROVIDER_RATE_LIMITED or STRUCTURED_OUTPUT_INVALID. */
  errorCode?: string };
export type WorkerJob = {
  jobId: string; kind: "agent" | "bulk"; state: JobState; parentSessionName: string; attemptId: string; ownerKey?: string;
  configRevision: number; config: WorkerConfig; idempotencyKey: string; fingerprint: string; createdAt: string; updatedAt: string;
  request: AgentSubmit | BulkSubmit; childSessionName?: string; resumedFromJobId?: string; results: ItemResult[]; error?: string;
  /** Earliest time a provider-limit pause may be resumed (Retry-After or a provider reset header). */
  resumeAfter?: string;
  /** Set for jobs submitted over a principal socket (P3); parentSessionName is then `principal:<principalId>`. Absent for chat-attempt jobs. */
  principalId?: string; runId?: string;
};
/** Job metadata stays bounded regardless of the number or size of item inputs. */
export type WorkerJobHeader = Omit<WorkerJob, "request" | "results"> & {
  request: AgentSubmit | Omit<BulkSubmit, "items">;
};
export type JobProgress = Record<JobState, number> & { total: number };
export type ResultPage = { jobId: string; results: (ItemResult & { revision: number })[]; nextCursor: number; hasMore: boolean };
export type PageOptions = { after?: number; limit?: number };
export type UsageReceipt = {
  version: 1; requestId: string; parentSessionName: string; sessionName: string; attemptId: string; jobId?: string; itemId?: string; ownerKey?: string;
  providerId: string; model: string; role: "main" | "subagent"; promptSha256: string;
  httpStatus?: number; errorCode?: string; authTransport?: "authorization" | "api-key" | "missing";
  state: "running" | "completed" | "failed" | "cancelled" | "interrupted"; usage: StatisticsTokens; createdAt: string; updatedAt: string;
  /** Attempt number of a bulk item call (1 for the first call, higher for broker retries). */
  attempt?: number;
  /** Upstream system_fingerprint, else the served model plus a digest of the server identity headers; never empty. */
  serverFingerprint?: string;
  /** sha256 of the canonical JSON of the effective request settings. */
  settingsSha256?: string;
  /**
   * Bulk calls: sha256 of the canonical JSON (fingerprint.ts canonicalJson) of the request body sent
   * upstream. A verbatim instrument call sends exactly those canonical bytes, so this is also the sha256
   * of the bytes on the wire and the executor can recompute it from the request it built.
   */
  requestSha256?: string;
  finishReason?: string | null; instrumentDigest?: string;
};
export type RuntimeParticipant = {
  sessionName: string; parentSessionName: string; attemptId: string; directory: string; provider: ModelProviderConfig;
  ownerKey?: string; permissionMode: PermissionMode; interactionMode: InteractionMode; config: AdvancedOrchestration;
  jobId?: string; admissionOpen: boolean;
  /** A run principal (P3) instead of a chat turn: its grants, not the turn mode, carry bulk authority. */
  principalId?: string; runId?: string;
};
export type RuntimeDriver = {
  start: (params: StartParams) => Promise<ToolResult>;
  quiesce: (name: string) => Promise<void>;
  purge?: (name: string) => Promise<void>;
  getSession: (name: string) => SessionInfo | null;
  getOwner?: (name: string) => string | undefined;
  contribution: (receipt: UsageReceipt) => void;
  /**
   * Bulk receipt updates in batches (the newest state per request, at most every
   * 50 ms), so statistics and the usage ledger commit once per batch instead of
   * once per call. Without it each receipt goes to contribution().
   */
  contributions?: (receipts: UsageReceipt[]) => void;
  registerChild?: (parent: string, child: string) => void;
};
