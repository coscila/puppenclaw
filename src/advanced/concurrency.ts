/** An operator-configured, aggregate bulk limit. Native controller calls are unaffected. */
export type BulkConcurrencyOptions = {
  defaultLimit: number;
  providerLimits?: Record<string, number>;
  providerGroups?: Record<string, string>;
  groupLimits?: Record<string, number>;
};
type Waiter = { resolve: (release: () => void) => void; reject: (error: Error) => void; signal: AbortSignal; abort: () => void };
type Pool = { active: number; queue: Waiter[] };
const positive = (value: unknown): number => { const limit = typeof value === "number" || typeof value === "string" ? Number(value) : NaN; if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Bulk provider concurrency must be a positive safe integer."); return limit; };
function entries(value: unknown, label: string): [string, unknown][] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return Object.entries(value).map(([key, item]) => {
    identifier(key, label);
    return [key, item];
  });
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} must contain nonempty provider or group names without whitespace padding or control characters.`);
  return value;
}
export function bulkConcurrencyFromEnvironment(env: NodeJS.ProcessEnv = process.env): BulkConcurrencyOptions {
  const defaultLimit = positive(env.PUPPENCLAW_BULK_PROVIDER_CONCURRENCY ?? 60);
  const providerLimits = Object.fromEntries(entries(JSON.parse(env.PUPPENCLAW_BULK_PROVIDER_LIMITS ?? "{}"), "PUPPENCLAW_BULK_PROVIDER_LIMITS").map(([id, limit]) => [id, positive(limit)]));
  const providerGroups = Object.fromEntries(entries(JSON.parse(env.PUPPENCLAW_BULK_PROVIDER_GROUPS ?? "{}"), "PUPPENCLAW_BULK_PROVIDER_GROUPS").map(([id, group]) => [id, identifier(group, "PUPPENCLAW_BULK_PROVIDER_GROUPS")]));
  const groupLimits = Object.fromEntries(entries(JSON.parse(env.PUPPENCLAW_BULK_GROUP_LIMITS ?? "{}"), "PUPPENCLAW_BULK_GROUP_LIMITS").map(([id, limit]) => [id, positive(limit)]));
  return { defaultLimit, providerLimits,
    ...(env.PUPPENCLAW_BULK_PROVIDER_GROUPS !== undefined ? { providerGroups } : {}),
    ...(env.PUPPENCLAW_BULK_GROUP_LIMITS !== undefined ? { groupLimits } : {}) };
}
export class BulkConcurrencyLimiter {
  private readonly pools = new Map<string, Pool>();
  private readonly defaultLimit: number;
  private readonly providerLimits: Map<string, number>;
  private readonly providerGroups: Map<string, string>;
  private readonly groupLimits: Map<string, number>;
  constructor(options = bulkConcurrencyFromEnvironment()) {
    this.defaultLimit = positive(options.defaultLimit);
    this.providerLimits = new Map(entries(options.providerLimits ?? {}, "Provider limits").map(([id, limit]) => [id, positive(limit)]));
    this.providerGroups = new Map(entries(options.providerGroups ?? {}, "Provider groups").map(([id, group]) => [id, identifier(group, "Provider groups")]));
    const explicitLimits = new Map(entries(options.groupLimits ?? {}, "Group limits").map(([id, limit]) => [id, positive(limit)]));
    this.groupLimits = new Map();
    for (const [provider, group] of this.providerGroups) {
      const limit = this.providerLimits.get(provider) ?? this.defaultLimit;
      this.groupLimits.set(group, Math.min(this.groupLimits.get(group) ?? limit, limit));
    }
    for (const [group, limit] of explicitLimits) {
      if (!this.groupLimits.has(group)) throw new Error(`Bulk capacity group ${group} has a limit but no provider members.`);
      this.groupLimits.set(group, limit);
    }
  }
  group(provider: string): string | undefined { return this.providerGroups.get(provider); }
  private key(provider: string): string {
    const group = this.group(provider);
    // A group name must not accidentally alias an ungrouped provider with the same name.
    return JSON.stringify(group === undefined ? ["provider", provider] : ["group", group]);
  }
  limit(provider: string): number {
    const group = this.group(provider);
    return group === undefined ? this.providerLimits.get(provider) ?? this.defaultLimit : this.groupLimits.get(group)!;
  }
  /** Current provider-wide permits and queued requests, without mutable pool state. */
  snapshot(provider: string): { limit: number; active: number; waiting: number } {
    const pool = this.pools.get(this.key(provider));
    return { limit: this.limit(provider), active: pool?.active ?? 0, waiting: pool?.queue.length ?? 0 };
  }
  async acquire(provider: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    const key = this.key(provider);
    const pool = this.pools.get(key) ?? { active: 0, queue: [] }; this.pools.set(key, pool);
    if (pool.active < this.limit(provider)) { pool.active++; return this.release(key, pool); }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, abort: () => { const index = pool.queue.indexOf(waiter); if (index >= 0) pool.queue.splice(index, 1); reject(new Error("Bulk dispatch cancelled while waiting for provider capacity.")); } };
      pool.queue.push(waiter); signal.addEventListener("abort", waiter.abort, { once: true });
    });
  }
  private release(key: string, pool: Pool): () => void {
    let released = false;
    return () => {
      if (released) return; released = true;
      const next = pool.queue.shift();
      if (next) { next.signal.removeEventListener("abort", next.abort); next.resolve(this.release(key, pool)); }
      else { pool.active--; if (pool.active === 0) this.pools.delete(key); }
    };
  }
}
