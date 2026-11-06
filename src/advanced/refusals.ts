import { PuppenclawError } from "../shared/errors.js";
import type { BrokerRefusalKind, BrokerRefusalPayload } from "./outbox.js";
import type { RuntimeParticipant } from "./types.js";

/**
 * Broker refusals as containment records (brokerOutbox:3, the broker.refusal event). Whenever the broker refuses a
 * participant's request because it reaches outside the participant's boundaries (a network destination the egress
 * proxy denies, work without a grant or for a provider or model not granted, a revoked or expired run principal, an
 * instrument that is not allowed, a credential the participant does not hold), it writes one outbox event naming who
 * asked, what for and the refusal's closed code. Refusals the participant cannot cause by reaching further (a closed
 * turn, an exhausted budget, a daemon shutting down, a malformed request) are not recorded.
 *
 * A client that repeats a refused request in a loop must not flood the outbox: the first refusal of a kind of request
 * is written at once, and identical refusals (same participant, job, kind, target and code) within the next
 * REFUSAL_FOLD_WINDOW_MS are counted and written as one more event whose `repeats` holds their number, when the window
 * closes or the runtime closes. The sum of `repeats` is the number of refused requests.
 */

/** The refusal codes that count as containment, by what the refused request reached for. */
export const REFUSAL_KINDS: Readonly<Record<string, BrokerRefusalKind>> = Object.freeze({
  EGRESS_DENIED: "egress",
  // Work without a grant: no principal or approved execution turn, a worker delegating or controlling jobs, a provider
  // or worker outside the grants or the worker policy.
  PRINCIPAL_REQUIRED: "grant",
  PROVIDER_NOT_GRANTED: "grant",
  GRANT_WITHDRAWN: "grant",
  WORKER_DELEGATION_DENIED: "grant",
  WORKER_CONTROL_DENIED: "grant",
  WORKER_CONFIG_NOT_FOUND: "grant",
  BULK_EXECUTION_REQUIRED: "grant",
  WORKER_PERMISSION_DENIED: "grant",
  PRINCIPAL_AGENT_UNSUPPORTED: "grant",
  CAPABILITY_PROFILE_DENIED: "grant",
  PROVIDER_NOT_ON_PREMISES: "grant",
  INSTRUMENT_NOT_ALLOWED: "instrument",
  INSTRUMENT_NOT_GRANTED: "instrument",
  INSTRUMENT_REQUIRED: "instrument",
  INSTRUMENT_NOT_PINNED: "instrument",
  INSTRUMENT_MESSAGE_MISMATCH: "instrument",
  // A run principal's socket is its credential; an API key or OAuth exchange the participant does not hold.
  PRINCIPAL_REVOKED: "credential",
  PRINCIPAL_EXPIRED: "credential",
  PROVIDER_AUTHENTICATION_REQUIRED: "credential",
  OAUTH_ROUTE_DENIED: "credential",
  OAUTH_REFRESH_REFUSED: "credential",
  MODEL_NOT_CONFIGURED: "model"
});

export const REFUSAL_FOLD_WINDOW_MS = 60_000;
/** Open fold windows kept at once; beyond this the oldest is written out early. */
export const REFUSAL_FOLD_MAX_OPEN = 4_096;
/** A target is a short identifier (host:port, provider, model, digest, principal); longer values are cut. */
export const REFUSAL_TARGET_MAX_CHARS = 256;

export function refusalKind(code: string): BrokerRefusalKind | undefined {
  return Object.hasOwn(REFUSAL_KINDS, code) ? REFUSAL_KINDS[code] : undefined;
}

/** The target a refusal error names (`details.target`), if any. */
export function refusalTargetOf(error: unknown): string | undefined {
  if (!(error instanceof PuppenclawError)) return undefined;
  const target = error.details?.target;
  return typeof target === "string" && target.length > 0 ? target : undefined;
}

/** The participant fields of a refusal: who asked and for which job. */
export type RefusalSubject = Pick<BrokerRefusalPayload, "sessionName" | "attemptId" | "principalId" | "jobId">;

/**
 * A worker agent reports under its parent's session, with its own job; a principal under `principal:<id>` without a
 * chat attempt (a principal's attempt id is its own id).
 */
export function refusalSubject(participant: Pick<RuntimeParticipant, "parentSessionName" | "attemptId" | "principalId" | "jobId">, jobId?: string): RefusalSubject {
  return {
    sessionName: participant.parentSessionName,
    attemptId: participant.principalId !== undefined ? null : participant.attemptId,
    principalId: participant.principalId ?? null,
    jobId: jobId ?? participant.jobId ?? null
  };
}

/**
 * An identifier as a target: letters, digits and . _ - : / @ + [ ] only (a host:port, model, provider, digest,
 * principal, worker or job), anything else replaced by ?, at most REFUSAL_TARGET_MAX_CHARS. A target names what a
 * request reached for; it never carries the request's text.
 */
export function refusalTarget(value: string): string {
  const text = value.replace(/[^A-Za-z0-9._:/@+[\]-]/gu, "?");
  return text.length > REFUSAL_TARGET_MAX_CHARS ? text.slice(0, REFUSAL_TARGET_MAX_CHARS) : text;
}

type FoldWindow = { payload: BrokerRefusalPayload; folded: number; lastAt: string; closesAt: number };
export type RefusalRecorderOptions = { windowMs?: number; maxOpen?: number; now?: () => number };

export class RefusalRecorder {
  private readonly open = new Map<string, FoldWindow>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly windowMs: number;
  private readonly maxOpen: number;
  private readonly now: () => number;

  /** `write` stores one event; it never throws into a request (the store's write is asynchronous). */
  constructor(private readonly write: (payload: BrokerRefusalPayload) => void, options: RefusalRecorderOptions = {}) {
    this.windowMs = options.windowMs ?? REFUSAL_FOLD_WINDOW_MS;
    this.maxOpen = options.maxOpen ?? REFUSAL_FOLD_MAX_OPEN;
    this.now = options.now ?? Date.now;
  }

  /** Records one refused request; false when `code` is not a containment refusal (nothing is written). */
  record(subject: RefusalSubject, code: string, target: string): boolean {
    const kind = refusalKind(code);
    if (kind === undefined || this.closed) return false;
    const now = this.now(), at = new Date(now).toISOString();
    const payload: BrokerRefusalPayload = { ...subject, kind, target: refusalTarget(target), code, at, repeats: 1 };
    const key = JSON.stringify([payload.sessionName, payload.attemptId, payload.principalId, payload.jobId, kind, payload.target, code]);
    const window = this.open.get(key);
    if (window && now < window.closesAt) {
      window.folded += 1;
      window.lastAt = at;
      return true;
    }
    if (window) this.closeWindow(key, window);
    this.emit(payload);
    this.open.set(key, { payload, folded: 0, lastAt: at, closesAt: now + this.windowMs });
    if (this.open.size > this.maxOpen) {
      const [oldestKey, oldest] = this.open.entries().next().value!;
      this.closeWindow(oldestKey, oldest);
    }
    this.schedule();
    return true;
  }

  /** Writes the folded counts of the windows that closed by now (all of them with `all`). */
  flush(all = false): void {
    const now = this.now();
    for (const [key, window] of [...this.open]) if (all || now >= window.closesAt) this.closeWindow(key, window);
  }

  /** Drops the open windows of an erased session without writing their folded counts. */
  discard(sessionName: string): void {
    for (const [key, window] of [...this.open]) if (window.payload.sessionName === sessionName) this.open.delete(key);
  }

  /** Writes every folded count and records nothing more (runtime close, before the store closes). */
  close(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.flush(true);
    this.closed = true;
  }

  /** Open fold windows (diagnostics and tests). */
  get openWindows(): number { return this.open.size; }

  private closeWindow(key: string, window: FoldWindow): void {
    this.open.delete(key);
    if (window.folded > 0) this.emit({ ...window.payload, at: window.lastAt, repeats: window.folded });
  }

  private emit(payload: BrokerRefusalPayload): void {
    try { this.write(payload); } catch { /* a refusal record never fails the refused request */ }
  }

  private schedule(): void {
    if (this.timer || this.open.size === 0 || this.closed) return;
    let next = Infinity;
    for (const window of this.open.values()) next = Math.min(next, window.closesAt);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
      this.schedule();
    }, Math.max(0, next - this.now()));
    this.timer.unref?.();
  }
}
