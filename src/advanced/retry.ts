/**
 * Broker retries for bulk item calls (plan P2): 502, 503 and 504 responses and
 * transport failures (connection resets, refused or unreachable upstreams,
 * timeouts) are retried with exponential backoff and jitter. Each attempt is a
 * new provider request with its own receipt row; the item settles once, with
 * the receipt of the attempt that ended it. Rate limits (429) and
 * authentication failures (401, 403) are never retried: they pause the provider
 * for the attempt, and a 503 that outlasts every attempt does too.
 */
export type BulkRetryOptions = { attempts: number; baseDelayMs: number; maxDelayMs: number };

export const RETRYABLE_HTTP_STATUS = new Set([502, 503, 504]);
export const RETRYABLE_TRANSPORT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "BULK_RESPONSE_TIMEOUT"
]);
/** HTTP statuses that pause the provider for the attempt (503 only once retries are exhausted). */
export const PAUSE_HTTP_STATUS = new Set([401, 403, 429, 503]);

const integer = (raw: string | undefined, name: string, fallback: number, min: number, max: number): number => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value;
};

export function bulkRetryFromEnvironment(env: NodeJS.ProcessEnv = process.env): BulkRetryOptions {
  return {
    attempts: integer(env.PUPPENCLAW_BULK_RETRY_ATTEMPTS, "PUPPENCLAW_BULK_RETRY_ATTEMPTS", 3, 1, 10),
    baseDelayMs: integer(env.PUPPENCLAW_BULK_RETRY_BASE_MS, "PUPPENCLAW_BULK_RETRY_BASE_MS", 1_000, 0, 60_000),
    maxDelayMs: 30_000
  };
}

/** Exponential backoff with ±20 % jitter: base·2^(attempt−1), capped. */
export function retryDelayMs(options: BulkRetryOptions, attempt: number, random: () => number = Math.random): number {
  const nominal = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(nominal * (0.8 + 0.4 * random()));
}

/** Waits unless the signal aborts first; false when aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(true); }, ms);
    const stop = () => { clearTimeout(timer); resolve(false); };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/** Closed failure code of a provider response or transport failure. */
export function failureCodeForStatus(status: number): string {
  if (status === 429) return "PROVIDER_RATE_LIMITED";
  if (status === 401 || status === 403) return "PROVIDER_AUTH_REQUIRED";
  if (status === 404) return "MODEL_UNAVAILABLE";
  if (status >= 500) return "PROVIDER_UNREACHABLE";
  return "INVALID_REQUEST";
}

type HeaderSource = { get(name: string): string | null };
const MAX_RESUME_MS = 7 * 24 * 60 * 60_000;

/** OpenAI-style reset durations such as "1s", "6m0s", "1h2m3.5s" or "20ms". */
function duration(value: string): number | null {
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/u.exec(value.trim());
  if (!match || value.trim() === "") return null;
  const [, h, m, s, ms] = match;
  return (Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)) * 1000 + Number(ms ?? 0);
}

/**
 * When a provider-limit pause may end: Retry-After (seconds or an HTTP date)
 * wins; otherwise the latest provider reset (x-ratelimit-reset-*,
 * anthropic-ratelimit-*-reset, ratelimit-reset). Undefined when none is usable.
 */
export function resumeAfterFromHeaders(headers: HeaderSource, now: Date = new Date()): string | undefined {
  const at = (ms: number | null): number | null => ms === null || !Number.isFinite(ms) || ms < 0 || ms > MAX_RESUME_MS ? null : now.getTime() + ms;
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = /^\d+(?:\.\d+)?$/u.test(retryAfter) ? at(Number(retryAfter) * 1000) : null;
    const date = seconds === null ? Date.parse(retryAfter) : Number.NaN;
    const value = seconds ?? (Number.isFinite(date) ? at(Math.max(0, date - now.getTime())) : null);
    if (value !== null) return new Date(value).toISOString();
  }
  const candidates: number[] = [];
  for (const name of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const raw = headers.get(name); if (!raw) continue;
    const value = at(duration(raw)); if (value !== null) candidates.push(value);
  }
  for (const name of ["anthropic-ratelimit-requests-reset", "anthropic-ratelimit-tokens-reset", "anthropic-ratelimit-input-tokens-reset", "anthropic-ratelimit-output-tokens-reset"]) {
    const raw = headers.get(name); if (!raw) continue;
    const parsed = Date.parse(raw); if (Number.isFinite(parsed)) { const value = at(Math.max(0, parsed - now.getTime())); if (value !== null) candidates.push(value); }
  }
  const reset = headers.get("ratelimit-reset");
  if (reset && /^\d+$/u.test(reset.trim())) { const value = at(Number(reset.trim()) * 1000); if (value !== null) candidates.push(value); }
  return candidates.length > 0 ? new Date(Math.max(...candidates)).toISOString() : undefined;
}
