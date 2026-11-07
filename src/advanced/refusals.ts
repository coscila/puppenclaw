import { PuppenclawError } from "../shared/errors.js";
import type { BrokerRefusalKind, BrokerRefusalPayload } from "./outbox.js";
import type { RuntimeParticipant } from "./types.js";

/**
 * Broker refusals as containment records (brokerOutbox:3, the broker.refusal event). Whenever the broker refuses a
 * participant's request because it reaches outside the participant's boundaries (a network destination the egress
 * proxy denies or a principal socket does not tunnel, work without a grant or for a provider or model not granted, an
 * instrument that is not allowed or an item that deviates from it, a credential the participant does not hold), it
 * writes one outbox event naming who asked, what for and the refusal's closed code. Refusals the participant cannot
 * cause by reaching further are not recorded: a closed turn, an exhausted budget, a run principal the lab revoked,
 * whose granted time ran out or whose grant it withdrew, a daemon shutting down, a malformed request, and the items
 * of a stored job refused because configuration changed after the job was admitted.
 *
 * A client that repeats a refused request in a loop must not flood the outbox: the first refusal of a kind of request
 * is written at once, and identical refusals (same participant, job, kind, target and code) within the next
 * REFUSAL_FOLD_WINDOW_MS are counted and written as one more event whose `repeats` holds their number, when the window
 * closes or the runtime closes. Nor must a client that reaches for many targets (a scan of hosts): beyond
 * REFUSAL_TARGETS_PER_CODE targets with an open window for one participant, job, kind and code, the further targets
 * share one window whose target is REFUSAL_OVERFLOW_TARGET. The sum of `repeats` is the number of refused requests.
 */

/** The refusal codes that count as containment, by what the refused request reached for. */
export const REFUSAL_KINDS: Readonly<Record<string, BrokerRefusalKind>> = Object.freeze({
  EGRESS_DENIED: "egress",
  // Work without a grant: no principal or approved execution turn, a worker delegating or controlling jobs, a provider
  // or worker outside the grants or the worker policy, agent work or a native model route on a principal socket.
  PRINCIPAL_REQUIRED: "grant",
  PROVIDER_NOT_GRANTED: "grant",
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
  // An API key or OAuth exchange the participant does not hold.
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
/** Targets with a window of their own per participant, job, kind and code; the further ones share the overflow target. */
export const REFUSAL_TARGETS_PER_CODE = 64;
/** The target of the refusals beyond REFUSAL_TARGETS_PER_CODE; refusalTarget never yields it. */
export const REFUSAL_OVERFLOW_TARGET = "*";

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

/** `group`: participant, job, kind and code; `overflow`: the window of the targets beyond REFUSAL_TARGETS_PER_CODE. */
type FoldWindow = { payload: BrokerRefusalPayload; group: string; overflow: boolean; folded: number; lastAt: string; closesAt: number };
export type RefusalRecorderOptions = { windowMs?: number; maxOpen?: number; targetsPerCode?: number; now?: () => number };

export class RefusalRecorder {
  private readonly open = new Map<string, FoldWindow>();
  /** Open windows of named targets per group (participant, job, kind and code). */
  private readonly targets = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly windowMs: number;
  private readonly maxOpen: number;
  private readonly targetsPerCode: number;
  private readonly now: () => number;

  /** `write` stores one event; it never throws into a request (the store's write is asynchronous). */
  constructor(private readonly write: (payload: BrokerRefusalPayload) => void, options: RefusalRecorderOptions = {}) {
    this.windowMs = options.windowMs ?? REFUSAL_FOLD_WINDOW_MS;
    this.maxOpen = options.maxOpen ?? REFUSAL_FOLD_MAX_OPEN;
    this.targetsPerCode = options.targetsPerCode ?? REFUSAL_TARGETS_PER_CODE;
    this.now = options.now ?? Date.now;
  }

  /** Records one refused request; false when `code` is not a containment refusal (nothing is written). */
  record(subject: RefusalSubject, code: string, target: string): boolean {
    const kind = refusalKind(code);
    if (kind === undefined || this.closed) return false;
    const now = this.now(), at = new Date(now).toISOString();
    const group = JSON.stringify([subject.sessionName, subject.attemptId, subject.principalId, subject.jobId, kind, code]);
    // The target's own window, or beyond targetsPerCode open ones of the group, the group's overflow window.
    let named = refusalTarget(target);
    let overflow = false;
    for (;;) {
      const key = JSON.stringify([group, named]);
      const window = this.open.get(key);
      if (window && now < window.closesAt) {
        window.folded += 1;
        window.lastAt = at;
        return true;
      }
      if (window) this.closeWindow(key, window);
      if (overflow || (this.targets.get(group) ?? 0) < this.targetsPerCode) break;
      named = REFUSAL_OVERFLOW_TARGET;
      overflow = true;
    }
    const payload: BrokerRefusalPayload = { ...subject, kind, target: named, code, at, repeats: 1 };
    this.emit(payload);
    this.open.set(JSON.stringify([group, named]), { payload, group, overflow, folded: 0, lastAt: at, closesAt: now + this.windowMs });
    if (!overflow) this.targets.set(group, (this.targets.get(group) ?? 0) + 1);
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
    for (const [key, window] of [...this.open]) if (window.payload.sessionName === sessionName) this.forget(key, window);
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
    this.forget(key, window);
    if (window.folded > 0) this.emit({ ...window.payload, at: window.lastAt, repeats: window.folded });
  }

  private forget(key: string, window: FoldWindow): void {
    this.open.delete(key);
    if (window.overflow) return;
    const named = (this.targets.get(window.group) ?? 1) - 1;
    if (named > 0) this.targets.set(window.group, named);
    else this.targets.delete(window.group);
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
