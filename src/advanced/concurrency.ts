/** An operator-configured, aggregate bulk limit. Native controller calls are unaffected. */
export type BulkConcurrencyOptions = { defaultLimit: number; providerLimits?: Record<string, number> };
type Waiter = { resolve: (release: () => void) => void; reject: (error: Error) => void; signal: AbortSignal; abort: () => void };
type Pool = { active: number; queue: Waiter[] };
const positive = (value: unknown): number => { const limit = typeof value === "number" || typeof value === "string" ? Number(value) : NaN; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error("Bulk provider concurrency must be an integer between 1 and 10000."); return limit; };
export function bulkConcurrencyFromEnvironment(env: NodeJS.ProcessEnv = process.env): BulkConcurrencyOptions {
  const defaultLimit = positive(env.PUPPENCLAW_BULK_PROVIDER_CONCURRENCY ?? 60);
  const raw: unknown = JSON.parse(env.PUPPENCLAW_BULK_PROVIDER_LIMITS ?? "{}");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("PUPPENCLAW_BULK_PROVIDER_LIMITS must be a JSON object of provider ids and concurrency limits.");
  return { defaultLimit, providerLimits: Object.fromEntries(Object.entries(raw).map(([id, limit]) => [id, positive(limit)])) };
}
export class BulkConcurrencyLimiter {
  private readonly pools = new Map<string, Pool>();
  private readonly options: BulkConcurrencyOptions;
  constructor(options = bulkConcurrencyFromEnvironment()) {
    this.options = { defaultLimit: positive(options.defaultLimit), providerLimits: Object.fromEntries(Object.entries(options.providerLimits ?? {}).map(([id, value]) => [id, positive(value)])) };
  }
  limit(provider: string): number { const limits = this.options.providerLimits; return limits && Object.hasOwn(limits, provider) ? limits[provider]! : this.options.defaultLimit; }
  async acquire(provider: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    const pool = this.pools.get(provider) ?? { active: 0, queue: [] }; this.pools.set(provider, pool);
    if (pool.active < this.limit(provider)) { pool.active++; return this.release(provider, pool); }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, abort: () => { const index = pool.queue.indexOf(waiter); if (index >= 0) pool.queue.splice(index, 1); reject(new Error("Bulk dispatch cancelled while waiting for provider capacity.")); } };
      pool.queue.push(waiter); signal.addEventListener("abort", waiter.abort, { once: true });
    });
  }
  private release(provider: string, pool: Pool): () => void {
    let released = false;
    return () => {
      if (released) return; released = true;
      const next = pool.queue.shift();
      if (next) { next.signal.removeEventListener("abort", next.abort); next.resolve(this.release(provider, pool)); }
      else { pool.active--; if (pool.active === 0) this.pools.delete(provider); }
    };
  }
}
