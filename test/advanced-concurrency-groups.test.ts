import { describe, expect, it } from "vitest";
import { BulkConcurrencyLimiter, bulkConcurrencyFromEnvironment } from "../src/advanced/concurrency.js";

const profiles = ["none", "low", "medium", "xhigh"].map((effort) => `remote_qwen38_${effort}`);
const providerGroups = Object.fromEntries(profiles.map((id) => [id, "qwen38"]));

describe("operator-owned bulk capacity groups", () => {
  it("shares permits across reasoning profiles while preserving independent backends", async () => {
    const limiter = new BulkConcurrencyLimiter({ defaultLimit: 60, providerGroups, groupLimits: { qwen38: 1 } });
    const first = await limiter.acquire(profiles[0]!, new AbortController().signal);
    const waiting = limiter.acquire(profiles[1]!, new AbortController().signal);
    const cancelled = new AbortController();
    const rejected = limiter.acquire(profiles[2]!, cancelled.signal);
    expect(limiter.snapshot(profiles[3]!)).toEqual({ limit: 1, active: 1, waiting: 2 });
    cancelled.abort(); await expect(rejected).rejects.toThrow("cancelled");
    const independent = await limiter.acquire("another-backend", new AbortController().signal);
    // An ungrouped provider whose name equals the group is also independent.
    const sameName = await limiter.acquire("qwen38", new AbortController().signal);
    expect(limiter.snapshot(profiles[0]!)).toEqual({ limit: 1, active: 1, waiting: 1 });
    first(); (await waiting)(); independent(); sameName();
    for (const profile of profiles) expect(limiter.snapshot(profile)).toEqual({ limit: 1, active: 0, waiting: 0 });
  });

  it("uses the most restrictive member limit unless an operator explicitly overrides the group", () => {
    const options = { defaultLimit: 60, providerGroups, providerLimits: { [profiles[0]!]: 120, [profiles[1]!]: 20, unrelated: 7 } };
    const conservative = new BulkConcurrencyLimiter(options);
    for (const profile of profiles) expect(conservative.limit(profile)).toBe(20);
    expect(conservative.limit("unrelated")).toBe(7);
    expect(new BulkConcurrencyLimiter({ ...options, groupLimits: { qwen38: 80 } }).limit(profiles[2]!)).toBe(80);
    expect(new BulkConcurrencyLimiter({ defaultLimit: 60, providerGroups, providerLimits: { [profiles[0]!]: 120 } }).limit(profiles[0]!)).toBe(60);
  });

  it("reads arbitrary alias groups from deployment configuration without changing provider identity", () => {
    const options = bulkConcurrencyFromEnvironment({
      PUPPENCLAW_BULK_PROVIDER_GROUPS: JSON.stringify({ ...providerGroups, alternate: "different" }),
      PUPPENCLAW_BULK_GROUP_LIMITS: '{"qwen38":60,"different":2}',
    });
    const limiter = new BulkConcurrencyLimiter(options);
    expect(limiter.group(profiles[0]!)).toBe("qwen38");
    expect(limiter.group("alternate")).toBe("different");
    expect(limiter.group("unmapped")).toBeUndefined();
    expect(limiter.limit("alternate")).toBe(2);
    const prototype = new BulkConcurrencyLimiter({ defaultLimit: 3, providerGroups: JSON.parse('{"__proto__":"constructor"}'), groupLimits: { constructor: 1 } });
    expect(prototype.group("__proto__")).toBe("constructor");
    expect(prototype.limit("__proto__")).toBe(1);
    expect(prototype.limit("constructor")).toBe(3);
  });

  it("rejects malformed mappings and limits rather than admitting an unbounded pool", () => {
    for (const raw of ['[]', 'null', '{"qwen":true}', '{"qwen":""}', '{"qwen":" group "}', '{"":"group"}', '{"qwen":"g\\u0000"}']) {
      expect(() => bulkConcurrencyFromEnvironment({ PUPPENCLAW_BULK_PROVIDER_GROUPS: raw })).toThrow();
    }
    for (const raw of ['[]', 'null', '{"qwen":0}', '{"qwen":true}', '{"qwen":1.5}']) {
      expect(() => bulkConcurrencyFromEnvironment({ PUPPENCLAW_BULK_GROUP_LIMITS: raw })).toThrow();
    }
    expect(() => new BulkConcurrencyLimiter({ defaultLimit: 60, groupLimits: { orphan: 30 } })).toThrow("no provider members");
  });
});
