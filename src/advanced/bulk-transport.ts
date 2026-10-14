import { Agent, fetch as fetchWithDispatcher, type RequestInit } from "undici";

export const DEFAULT_BULK_RESPONSE_TIMEOUT_MS = 30 * 60_000;
const MAX_BULK_RESPONSE_TIMEOUT_MS = 24 * 60 * 60_000;

export function bulkResponseTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env.PUPPENCLAW_BULK_RESPONSE_TIMEOUT_MS;
  if (configured === undefined) return DEFAULT_BULK_RESPONSE_TIMEOUT_MS;
  const value = Number(configured);
  if (!/^\d+$/u.test(configured) || !Number.isSafeInteger(value) ||
      value <= 0 || value > MAX_BULK_RESPONSE_TIMEOUT_MS) {
    throw new Error("PUPPENCLAW_BULK_RESPONSE_TIMEOUT_MS must be a positive integer no greater than 86400000.");
  }
  return value;
}

class BulkResponseTimeoutError extends Error {
  readonly code = "BULK_RESPONSE_TIMEOUT";
  constructor(timeoutMs: number) {
    super(`Bulk provider response exceeded its ${timeoutMs} ms deadline.`);
    this.name = "BulkResponseTimeoutError";
  }
}

/** One deadline covers delayed headers and the complete response body. */
export class BulkRequestScope {
  readonly signal: AbortSignal;
  private readonly timeout = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(private readonly dispatcher: Agent, parent: AbortSignal, timeoutMs: number) {
    this.signal = AbortSignal.any([parent, this.timeout.signal]);
    this.timer = setTimeout(() => this.timeout.abort(new BulkResponseTimeoutError(timeoutMs)), timeoutMs);
    this.timer.unref();
  }

  fetch(url: URL, init: Omit<RequestInit, "dispatcher" | "signal">) {
    return fetchWithDispatcher(url, { ...init, dispatcher: this.dispatcher, signal: this.signal });
  }

  get timeoutError(): Error & { code: string } | undefined {
    return this.timeout.signal.aborted && this.signal.reason === this.timeout.signal.reason
      ? this.timeout.signal.reason as BulkResponseTimeoutError : undefined;
  }

  close(): void { clearTimeout(this.timer); }
}

/** Bulk inference is non-streaming and can legitimately spend minutes before headers. */
export class BulkResponseTransport {
  private readonly dispatcher: Agent;
  constructor(readonly timeoutMs: number = bulkResponseTimeout()) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_BULK_RESPONSE_TIMEOUT_MS) {
      throw new Error("Bulk response timeout must be a positive integer no greater than 86400000.");
    }
    this.dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  }

  // Acquire provider capacity before starting this scope: queue time is not inference time.
  start(parent: AbortSignal): BulkRequestScope { return new BulkRequestScope(this.dispatcher, parent, this.timeoutMs); }
  async close(): Promise<void> { await this.dispatcher.destroy(); }
}
