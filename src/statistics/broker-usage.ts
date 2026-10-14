import type { UsageReceipt } from "../advanced/types.js";
import type { RunnerTurnModelStatistics, StatisticsTokens } from "./types.js";
import { unavailableTokens } from "./tokens.js";

const keys = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"] as const;
type Entry = Pick<UsageReceipt, "role" | "providerId" | "model" | "state" | "usage"> & { thread: string };
/** Exact incremental sums with replace-by-request semantics and explicit unknown counters. */
class Totals {
  count = 0;
  running = 0;
  unmeasured = 0;
  private readonly sums = Object.fromEntries(keys.map((k) => [k, 0n])) as Record<typeof keys[number], bigint>;
  private readonly unknown = Object.fromEntries(keys.map((k) => [k, 0])) as Record<typeof keys[number], number>;
  add(entry: Entry, sign: 1 | -1): void {
    this.count += sign; this.running += entry.state === "running" ? sign : 0; this.unmeasured += entry.usage.quality !== "measured" ? sign : 0;
    for (const key of keys) { const value = entry.usage[key]; if (value === null) this.unknown[key] += sign; else this.sums[key] += BigInt(value) * BigInt(sign); }
  }
  snapshot(): StatisticsTokens {
    if (this.count === 0) return unavailableTokens();
    const result = Object.fromEntries(keys.map((key) => [key, this.unknown[key] || this.sums[key] > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(this.sums[key])])) as Omit<StatisticsTokens, "quality">;
    return { ...result, quality: !this.running && !this.unmeasured && result.input !== null && result.output !== null ? "measured" : "partial" };
  }
}
type Group = { role: Entry["role"]; model: string; providerId: string; totals: Totals; threads: Map<string, number> };
export class BrokerUsageAccumulator {
  private readonly entries = new Map<string, Entry>();
  private readonly groups = new Map<string, Group>();
  private readonly totals = new Totals();
  update(receipt: UsageReceipt): void {
    const previous = this.entries.get(receipt.requestId); if (previous) this.adjust(previous, -1);
    // Receipts are mutated by the parser after publication, so retain a value copy.
    const entry: Entry = { role: receipt.role, providerId: receipt.providerId, model: receipt.model, state: receipt.state, usage: { ...receipt.usage }, thread: receipt.jobId ?? receipt.sessionName };
    this.entries.set(receipt.requestId, entry); this.adjust(entry, 1);
  }
  private adjust(entry: Entry, sign: 1 | -1): void {
    const key = JSON.stringify([entry.role, entry.providerId, entry.model]);
    const group = this.groups.get(key) ?? { role: entry.role, model: entry.model, providerId: entry.providerId, totals: new Totals(), threads: new Map<string, number>() };
    this.totals.add(entry, sign); group.totals.add(entry, sign);
    const threads = (group.threads.get(entry.thread) ?? 0) + sign;
    if (threads) group.threads.set(entry.thread, threads); else group.threads.delete(entry.thread);
    if (group.totals.count) this.groups.set(key, group); else this.groups.delete(key);
  }
  snapshot(): { tokens: StatisticsTokens; models: RunnerTurnModelStatistics[]; incomplete: boolean } {
    return { tokens: this.totals.snapshot(), models: [...this.groups.values()].map((g) => ({ role: g.role, model: g.model, modelProviderId: g.providerId, threads: g.threads.size, tokens: g.totals.snapshot() })), incomplete: this.totals.unmeasured > 0 };
  }
}
