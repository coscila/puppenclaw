import { createHash } from "node:crypto";

import type { ItemResult, JobState, UsageReceipt, WorkerJobHeader } from "./types.js";

/**
 * pcp/2 broker outbox (capabilities eventFeed:1 and brokerOutbox:1). Every row
 * is written in the transaction that changes the job or settles the item, so
 * the feed can never miss or invent a change. Payload shapes are the binding
 * contract shared with coscila's feed collector; keep field names stable.
 */
export const BROKER_JOB_EVENT = "broker.job";
export const BROKER_RECEIPT_EVENT = "broker.receipt";
export type BrokerEventType = typeof BROKER_JOB_EVENT | typeof BROKER_RECEIPT_EVENT;

/** A receipt event carries the item output inline only up to this many UTF-8 bytes. */
export const INLINE_OUTPUT_MAX_BYTES = 16_384;
export const EVENT_PAGE_MAX = 1_000;
export const EVENT_PAGE_DEFAULT = 500;
export const EVENT_WAIT_MAX_MS = 25_000;

export type BrokerJobCounts = {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  truncated: number;
};

export type BrokerJobPayload = {
  jobId: string;
  ownerKey: string | null;
  principalId: string | null;
  runId: string | null;
  state: JobState;
  counts: BrokerJobCounts;
  instrumentDigest: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Link hints beyond the pcp/2 fields: the job's parent session (a chat's daemon session, or `principal:<id>`)
   * and its attempt. coscila ties a job to its chat by them, and erases a purged chat's jobs by its session.
   */
  parentSessionName: string;
  attemptId: string;
};

export type BrokerReceiptStatus = "succeeded" | "failed" | "truncated" | "cancelled";

export type BrokerReceiptPayload = {
  jobId: string;
  itemId: string;
  attempt: number;
  status: BrokerReceiptStatus;
  finishReason: string | null;
  usage: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null };
  model: string;
  serverFingerprint: string;
  settingsSha256: string;
  /** sha256 of the canonical JSON of the request body the settling call sent upstream; null when there is none (agent jobs, older receipts). */
  requestSha256: string | null;
  instrumentDigest: string | null;
  outputDigest: string;
  outputBytes: number;
  output?: unknown;
  startedAt: string;
  endedAt: string;
  error: { code: string; retryable: boolean } | null;
};

export type BrokerEvent = {
  seq: number;
  type: BrokerEventType;
  at: string;
  jobId: string;
  itemId?: string;
  payload: BrokerJobPayload | BrokerReceiptPayload;
};

/** Item states that end an item inside its job; a later completion of the same item is a duplicate. */
export const SETTLED_ITEM_STATES: readonly JobState[] = ["completed", "failed", "cancelled", "paused", "interrupted"];

/** Retryability of the closed failure codes a receipt can carry. */
const RETRYABLE_CODES = new Set([
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNREACHABLE",
  "PROVIDER_PAUSED",
  "TIME_LIMIT",
  "NO_FINAL_MESSAGE",
  "INTERRUPTED_RESTART"
]);

export function receiptError(code: string | undefined): { code: string; retryable: boolean } | null {
  return code == null ? null : { code, retryable: RETRYABLE_CODES.has(code) };
}

export function instrumentDigestOf(job: Pick<WorkerJobHeader, "kind" | "request">): string | null {
  if (job.kind !== "bulk") return null;
  const digest = (job.request as { instrumentDigest?: unknown }).instrumentDigest;
  return typeof digest === "string" ? digest : null;
}

/**
 * Counts by item state, folded into the contract's categories: paused and
 * interrupted items count as failed for their job (a resume runs them in a new
 * job); truncated items are counted once, apart from succeeded and failed.
 */
export function brokerJobCounts(
  byState: Partial<Record<JobState, number>>,
  truncatedByState: Partial<Record<JobState, number>>,
  running: number
): BrokerJobCounts {
  const n = (state: JobState) => byState[state] ?? 0;
  const t = (state: JobState) => truncatedByState[state] ?? 0;
  const total = Object.values(byState).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const inFlight = Math.min(running, n("queued"));
  const truncated = Object.values(truncatedByState).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return {
    total,
    queued: n("queued") - inFlight,
    running: inFlight + n("running"),
    succeeded: n("completed") - t("completed"),
    failed: n("failed") + n("interrupted") + n("paused") - t("failed") - t("interrupted") - t("paused"),
    cancelled: n("cancelled") - t("cancelled"),
    truncated
  };
}

export function brokerJobPayload(job: WorkerJobHeader, counts: BrokerJobCounts): BrokerJobPayload {
  return {
    jobId: job.jobId,
    ownerKey: job.ownerKey ?? null,
    principalId: job.principalId ?? null,
    runId: job.runId ?? null,
    state: job.state,
    counts,
    instrumentDigest: instrumentDigestOf(job),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    parentSessionName: job.parentSessionName,
    attemptId: job.attemptId
  };
}

/** The exact text an output digest covers: a string as is, anything else as compact JSON. */
export function outputText(output: unknown): string {
  if (output === undefined) return "";
  return typeof output === "string" ? output : JSON.stringify(output) ?? "";
}

export function outputDigest(output: unknown): { digest: string; bytes: number; text: string } {
  const text = outputText(output);
  return { digest: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text), text };
}

export function receiptStatus(item: Pick<ItemResult, "state" | "truncated">): BrokerReceiptStatus {
  if (item.truncated === true) return "truncated";
  if (item.state === "completed") return "succeeded";
  if (item.state === "cancelled") return "cancelled";
  return "failed";
}

/**
 * The terminal receipt of one item: the settling call's transport receipt plus
 * the item outcome. One per item and job; the store refuses a second one.
 */
export function brokerReceiptPayload(input: {
  jobId: string;
  instrumentDigest: string | null;
  item: ItemResult;
  receipt: Pick<UsageReceipt, "model" | "usage" | "createdAt" | "updatedAt"> & Partial<Pick<UsageReceipt, "attempt" | "serverFingerprint" | "settingsSha256" | "requestSha256" | "finishReason">>;
  fallbackFingerprint: string;
  fallbackSettingsSha256: string;
  endedAt?: string;
}): BrokerReceiptPayload {
  const { item, receipt } = input;
  const output = item.output;
  const digest = outputDigest(output);
  const payload: BrokerReceiptPayload = {
    jobId: input.jobId,
    itemId: item.id,
    attempt: receipt.attempt ?? item.attempts ?? 1,
    status: receiptStatus(item),
    finishReason: item.finishReason ?? receipt.finishReason ?? null,
    usage: {
      input: receipt.usage.input,
      output: receipt.usage.output,
      cacheRead: receipt.usage.cacheRead,
      cacheWrite: receipt.usage.cacheWrite
    },
    model: receipt.model,
    serverFingerprint: nonEmpty(item.serverFingerprint) ?? nonEmpty(receipt.serverFingerprint) ?? input.fallbackFingerprint,
    settingsSha256: nonEmpty(item.settingsSha256) ?? nonEmpty(receipt.settingsSha256) ?? input.fallbackSettingsSha256,
    requestSha256: nonEmpty(item.requestSha256) ?? nonEmpty(receipt.requestSha256) ?? null,
    instrumentDigest: input.instrumentDigest,
    outputDigest: digest.digest,
    outputBytes: digest.bytes,
    startedAt: receipt.createdAt,
    endedAt: input.endedAt ?? receipt.updatedAt,
    error: item.state === "completed" ? null : receiptError(item.errorCode ?? defaultErrorCode(item.state))
  };
  if (output !== undefined && digest.bytes <= INLINE_OUTPUT_MAX_BYTES) payload.output = output;
  return payload;
}

function defaultErrorCode(state: JobState): string {
  switch (state) {
    case "cancelled":
      return "CANCELLED";
    case "interrupted":
      return "INTERRUPTED_RESTART";
    case "paused":
      return "PROVIDER_PAUSED";
    default:
      return "INTERNAL";
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
