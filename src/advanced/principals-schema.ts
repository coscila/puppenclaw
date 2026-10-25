import { z } from "zod";

import { PuppenclawError } from "../shared/errors.js";
import { modelProviderConfigZod, ownerKeyZod } from "../shared/schema.js";
import type { ModelProviderConfig } from "../shared/types.js";
import type { AgentSubmit, BulkSubmit, RuntimeParticipant, UsageReceipt, WorkerConfig, WorkerJobHeader } from "./types.js";

/**
 * pcp/2 run principals (plan P3, capability `principals:1`). coscila grants;
 * the daemon enforces. A principal's authority is its grants, and the only way
 * to act as a principal is its own unix socket: no header, body field or
 * environment variable names a principal.
 */

export const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
export const principalIdZod = z.string().regex(PRINCIPAL_ID_PATTERN, "Principal ids use 1-128 of A-Z a-z 0-9 . _ : -.");
const providerIdZod = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/u, "Provider ids use A-Z a-z 0-9 . _ -.");
/** Opaque instrument digests (coscila-review's registry computes them; the daemon never does). */
const instrumentDigestZod = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u, "Instrument digests are opaque ids of 1-128 URL-safe characters.");
const countZod = z.number().int().min(0).safe();

export const principalGrantsZod = z
  .object({
    providers: z.array(providerIdZod).max(64),
    instruments: z.array(instrumentDigestZod).max(256).default([]),
    maxConcurrency: z.number().int().min(1).max(100_000),
    maxItems: countZod.nullable().default(null),
    tokenBudget: z
      .object({ input: countZod.nullable().default(null), output: countZod.nullable().default(null) })
      .strict()
      .nullable()
      .default(null),
    expiresAt: z.iso.datetime({ offset: true }).nullable().default(null)
  })
  .strict()
  .superRefine((grants, context) => {
    if (new Set(grants.providers).size !== grants.providers.length)
      context.addIssue({ code: "custom", path: ["providers"], message: "Provider grants must be unique." });
    if (new Set(grants.instruments).size !== grants.instruments.length)
      context.addIssue({ code: "custom", path: ["instruments"], message: "Instrument grants must be unique." });
  });

export const principalPutZod = z
  .object({
    kind: z.enum(["run", "human"]),
    runId: z.string().regex(PRINCIPAL_ID_PATTERN, "Run ids use 1-128 of A-Z a-z 0-9 . _ : -.").nullable().default(null),
    ownerKey: ownerKeyZod,
    grants: principalGrantsZod,
    socket: z.boolean().default(false)
  })
  .strict()
  .superRefine((body, context) => {
    if (body.kind === "run" && body.runId === null)
      context.addIssue({ code: "custom", path: ["runId"], message: "A run principal is bound to a runId." });
    if (body.kind === "human" && body.runId !== null)
      context.addIssue({ code: "custom", path: ["runId"], message: "A human principal carries no runId." });
  });

export type PrincipalGrants = z.output<typeof principalGrantsZod>;
export type PrincipalPut = z.output<typeof principalPutZod>;
export type PrincipalKind = PrincipalPut["kind"];

/** Durable record (principals.sqlite). ownerKey is never returned by any route. */
export type PrincipalRecord = {
  id: string;
  kind: PrincipalKind;
  runId: string | null;
  ownerKey: string;
  grants: PrincipalGrants;
  socket: boolean;
  /** Private per-principal directory holding `broker.sock`; kept across restarts so a bound directory stays valid. */
  socketDir: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
};

export type PrincipalUsage = { items: number; inputTokens: number; outputTokens: number };
export type PrincipalState = "active" | "expired" | "revoked";

/** Why a principal job may not dispatch another item; also the paused job's `error`. */
export const PRINCIPAL_PAUSE_REASONS = {
  revoked: "principal_revoked",
  expired: "principal_expired",
  grant: "grant_withdrawn",
  budget: "budget_exhausted",
  shutdown: "daemon_shutdown"
} as const;
export type PrincipalPauseReason = (typeof PRINCIPAL_PAUSE_REASONS)[keyof typeof PRINCIPAL_PAUSE_REASONS];
const PAUSE_CODES: Record<PrincipalPauseReason, string> = {
  principal_revoked: "PRINCIPAL_REVOKED",
  principal_expired: "PRINCIPAL_EXPIRED",
  grant_withdrawn: "GRANT_WITHDRAWN",
  budget_exhausted: "BUDGET_EXHAUSTED",
  daemon_shutdown: "DAEMON_SHUTTING_DOWN"
};
export function principalRefusalError(reason: PrincipalPauseReason): PuppenclawError {
  return new PuppenclawError(PAUSE_CODES[reason], `Principal admission is closed: ${reason}.`, { pause: reason });
}
/** The closed failure code of a refusal (e.g. BUDGET_EXHAUSTED), as an item that was never dispatched records it. */
export function principalPauseCode(reason: PrincipalPauseReason): string {
  return PAUSE_CODES[reason];
}
/** The pause reason a principal refusal error carries; undefined for any other error. */
export function principalPauseOf(error: unknown): PrincipalPauseReason | undefined {
  if (!(error instanceof PuppenclawError)) return undefined;
  const pause = error.details?.pause;
  return typeof pause === "string" && Object.hasOwn(PAUSE_CODES, pause) ? pause as PrincipalPauseReason : undefined;
}

/** One item as maxItems counts it: its id within the job lineage (the first job of a resume chain). */
export type PrincipalItemKey = { lineage: string; itemId: string };
/** A held principal slot. `refund` takes back the item charge this admission made when its call never left. */
export type PrincipalAdmission = { release(): void; refund(): void };

/**
 * What the broker runtime asks of the principal registry. Chat-turn
 * participants (no principalId) never reach these hooks except for
 * `legacyAttemptAuthority`.
 */
export type PrincipalHooks = {
  /**
   * PUPPENCLAW_LEGACY_ATTEMPT_AUTHORITY (default on): a chat turn in execute +
   * approve-all mode may submit bulk work and is reported as public-literature
   * approved. Off: only principal sockets carry bulk authority.
   */
  readonly legacyAttemptAuthority: boolean;
  /** Throws when a principal may not submit this job (kind, provider, instrument, revoked, expired). */
  admitJob(participant: RuntimeParticipant, kind: "agent" | "bulk", request: AgentSubmit | BulkSubmit, config: WorkerConfig): void;
  /**
   * The pause reason that stops a principal job from dispatching another item, if any; no side effects. With
   * `items`, maxItems refuses only when one of them is not counted yet in its lineage.
   */
  refusal(participant: RuntimeParticipant, job: Pick<WorkerJobHeader, "config" | "request">, items?: readonly PrincipalItemKey[]): PrincipalPauseReason | undefined;
  /**
   * Waits for a concurrency slot of the principal and admits one call of an item. maxItems counts each item of a
   * job lineage once, at its first admission: a retry, a relaunch after a restart or a resume admits it again
   * without a new charge. The runtime passes the job it runs, so admission never reads the job store per item.
   */
  admitItem(participant: RuntimeParticipant, signal: AbortSignal, job?: Pick<WorkerJobHeader, "config" | "request">, item?: PrincipalItemKey): Promise<PrincipalAdmission>;
  /** Charges a settled principal receipt to the principal's token budget (once per request); others are ignored. */
  observeReceipt(receipt: UsageReceipt): void;
};

/** The instrument a job names (P2 stores it with the bulk request), if any. */
export function jobInstrumentDigest(job: Pick<WorkerJobHeader, "request"> & { instrumentDigest?: unknown }): string | undefined {
  const top = job.instrumentDigest;
  if (typeof top === "string" && top.length > 0) return top;
  const nested = (job.request as { instrumentDigest?: unknown } | undefined)?.instrumentDigest;
  return typeof nested === "string" && nested.length > 0 ? nested : undefined;
}

/**
 * PUPPENCLAW_LEGACY_ATTEMPT_AUTHORITY: `on` (default) keeps today's chat-turn
 * bulk authority; `off` leaves bulk authority to principals only. Any other
 * value fails startup, like the other broker settings.
 */
export function legacyAttemptAuthorityFromEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PUPPENCLAW_LEGACY_ATTEMPT_AUTHORITY?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "on") return true;
  if (raw === "off") return false;
  throw new Error("PUPPENCLAW_LEGACY_ATTEMPT_AUTHORITY must be on or off.");
}

/**
 * PUPPENCLAW_MODEL_PROVIDERS: the providers a principal can be granted, as a
 * JSON array of model provider configurations (the same shape a turn's
 * `modelProvider` has; `authTokenEnv` names a variable of the daemon
 * environment, never a secret). Grants name provider ids; the endpoint and
 * credential always come from here, never from a socket client. Unset means
 * no provider is available to principals. Invalid values fail startup.
 */
export function modelProvidersFromEnvironment(env: NodeJS.ProcessEnv = process.env): Map<string, ModelProviderConfig> {
  const raw = env.PUPPENCLAW_MODEL_PROVIDERS?.trim();
  if (!raw) return new Map();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("PUPPENCLAW_MODEL_PROVIDERS must be a JSON array of model provider configurations.");
  }
  const parsed = z.array(modelProviderConfigZod).max(256).safeParse(value);
  if (!parsed.success) throw new Error("PUPPENCLAW_MODEL_PROVIDERS must be a JSON array of model provider configurations.");
  const providers = new Map<string, ModelProviderConfig>();
  for (const provider of parsed.data) {
    if (providers.has(provider.id)) throw new Error(`PUPPENCLAW_MODEL_PROVIDERS lists provider ${provider.id} twice.`);
    providers.set(provider.id, provider);
  }
  return providers;
}

/** Order-insensitive identity of grants: the same sets and limits are the same grants. */
export function canonicalGrants(grants: PrincipalGrants): string {
  return JSON.stringify({
    providers: [...grants.providers].sort(),
    instruments: [...grants.instruments].sort(),
    maxConcurrency: grants.maxConcurrency,
    maxItems: grants.maxItems,
    tokenBudget: grants.tokenBudget,
    expiresAt: grants.expiresAt === null ? null : new Date(grants.expiresAt).toISOString()
  });
}

/** Stored and returned grants: as given, with expiresAt normalised to an ISO instant. */
export function normalizeGrants(grants: PrincipalGrants): PrincipalGrants {
  return { ...grants, expiresAt: grants.expiresAt === null ? null : new Date(grants.expiresAt).toISOString() };
}
