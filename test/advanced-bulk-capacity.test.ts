import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BulkResponseTransport } from "../src/advanced/bulk-transport.js";
import { BulkConcurrencyLimiter, bulkConcurrencyFromEnvironment } from "../src/advanced/concurrency.js";
import { AdvancedRuntime } from "../src/advanced/runtime.js";

// pcp/2 bulkCapacity: what the broker applies, read from the limiter, the transport and the retry settings in use.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.unstubAllEnvs();
});

const qwen38 = { remote_qwen38_none: "qwen38", remote_qwen38_low: "qwen38", remote_qwen38_medium: "qwen38" };
const BULK_ENV = ["PUPPENCLAW_BULK_PROVIDER_CONCURRENCY", "PUPPENCLAW_BULK_PROVIDER_LIMITS", "PUPPENCLAW_BULK_PROVIDER_GROUPS", "PUPPENCLAW_BULK_GROUP_LIMITS", "PUPPENCLAW_BULK_RESPONSE_TIMEOUT_MS", "PUPPENCLAW_BULK_RETRY_ATTEMPTS", "PUPPENCLAW_BULK_RETRY_BASE_MS"];
const bulkEnv = (values: Record<string, string> = {}) => { for (const key of BULK_ENV) vi.stubEnv(key, values[key]); };

describe("bulk capacity of the limiter", () => {
  it("reports the default limit for providers without their own limit or group", () => {
    const limiter = new BulkConcurrencyLimiter({ defaultLimit: 60 });
    expect(limiter.capacity(["remote_qwen38_none", "remote_qwen38_low"])).toEqual({
      defaultLimit: 60,
      providers: [
        { providerId: "remote_qwen38_low", limit: 60 },
        { providerId: "remote_qwen38_none", limit: 60 }
      ]
    });
    expect(limiter.capacity()).toEqual({ defaultLimit: 60, providers: [] });
  });

  it("names every provider the limits or groups configure, each group with its one shared limit", () => {
    const options = { defaultLimit: 60, providerGroups: qwen38, providerLimits: { remote_qwen38_low: 20, other: 7 } };
    const derived = new BulkConcurrencyLimiter(options);
    // Without an explicit group limit the group takes its most restrictive member's (low's 20, the others' default 60).
    expect(derived.capacity(["remote_qwen38_none", "configured_only"])).toEqual({
      defaultLimit: 60,
      providers: [
        { providerId: "configured_only", limit: 60 },
        { providerId: "other", limit: 7 },
        { providerId: "remote_qwen38_low", capacityGroup: "qwen38", limit: 20, groupLimit: 20 },
        { providerId: "remote_qwen38_medium", capacityGroup: "qwen38", limit: 20, groupLimit: 20 },
        { providerId: "remote_qwen38_none", capacityGroup: "qwen38", limit: 20, groupLimit: 20 }
      ]
    });
    const explicit = new BulkConcurrencyLimiter({ ...options, groupLimits: { qwen38: 48 } });
    const report = explicit.capacity(["remote_qwen38_none"]);
    expect(report.providers.filter((entry) => entry.capacityGroup === "qwen38").map((entry) => [entry.limit, entry.groupLimit])).toEqual([[48, 48], [48, 48], [48, 48]]);
    // Each reported limit is the one dispatch uses.
    for (const entry of report.providers) expect(entry.limit).toBe(explicit.limit(entry.providerId));
  });

  it("reads exactly what the deployment configured, names and numbers only", () => {
    const limiter = new BulkConcurrencyLimiter(bulkConcurrencyFromEnvironment({
      PUPPENCLAW_BULK_PROVIDER_CONCURRENCY: "40",
      PUPPENCLAW_BULK_PROVIDER_GROUPS: JSON.stringify(qwen38),
      PUPPENCLAW_BULK_GROUP_LIMITS: '{"qwen38":60}'
    }));
    const report = limiter.capacity(["remote_qwen38_none", "remote_qwen38_low", "remote_deepseek"]);
    expect(report.defaultLimit).toBe(40);
    expect(report.providers.map((entry) => entry.providerId)).toEqual(["remote_deepseek", "remote_qwen38_low", "remote_qwen38_medium", "remote_qwen38_none"]);
    for (const entry of report.providers) {
      for (const [key, value] of Object.entries(entry)) {
        expect(["providerId", "capacityGroup", "limit", "groupLimit"]).toContain(key);
        expect(typeof value === "number" ? Number.isSafeInteger(value) && value > 0 : typeof value === "string").toBe(true);
      }
    }
    // A provider id that is an Object.prototype name is reported as a value, never as a key.
    const prototype = new BulkConcurrencyLimiter({ defaultLimit: 3, providerGroups: JSON.parse('{"__proto__":"constructor"}'), groupLimits: { constructor: 1 } });
    expect(prototype.capacity(["constructor"]).providers).toEqual([
      { providerId: "__proto__", capacityGroup: "constructor", limit: 1, groupLimit: 1 },
      { providerId: "constructor", limit: 3 }
    ]);
  });
});

describe("bulk capacity of the runtime", () => {
  it("adds the per-attempt deadline and the retries the runtime was given", async () => {
    const runtime = await AdvancedRuntime.open(await mkdtemp(join(tmpdir(), "bulk-capacity-")), { defaultLimit: 12, providerGroups: qwen38, groupLimits: { qwen38: 30 } }, {
      transport: new BulkResponseTransport(600_000, new Map()),
      retry: { attempts: 2, baseDelayMs: 500, maxDelayMs: 30_000 }
    });
    cleanups.push(() => runtime.close());
    const capacity = runtime.bulkCapacity(["remote_qwen38_none"]);
    expect(capacity).toEqual({
      defaultLimit: 12,
      providers: [
        { providerId: "remote_qwen38_low", capacityGroup: "qwen38", limit: 30, groupLimit: 30 },
        { providerId: "remote_qwen38_medium", capacityGroup: "qwen38", limit: 30, groupLimit: 30 },
        { providerId: "remote_qwen38_none", capacityGroup: "qwen38", limit: 30, groupLimit: 30 }
      ],
      responseTimeoutMs: 600_000,
      retry: { attempts: 2, baseDelayMs: 500, maxDelayMs: 30_000 }
    });
    expect(capacity.providers.map((entry) => entry.limit)).toEqual(capacity.providers.map((entry) => runtime.bulkConcurrency.limit(entry.providerId)));
  });

  it("reports the environment's deadline and retries when none were given", async () => {
    bulkEnv({ PUPPENCLAW_BULK_PROVIDER_CONCURRENCY: "25", PUPPENCLAW_BULK_RESPONSE_TIMEOUT_MS: "900000", PUPPENCLAW_BULK_RETRY_ATTEMPTS: "4", PUPPENCLAW_BULK_RETRY_BASE_MS: "250" });
    const runtime = await AdvancedRuntime.open(await mkdtemp(join(tmpdir(), "bulk-capacity-env-")));
    cleanups.push(() => runtime.close());
    expect(runtime.bulkCapacity(["remote_qwen38_none"])).toEqual({
      defaultLimit: 25,
      providers: [{ providerId: "remote_qwen38_none", limit: 25 }],
      responseTimeoutMs: 900_000,
      retry: { attempts: 4, baseDelayMs: 250, maxDelayMs: 30_000 }
    });
  });

  it("reports the defaults: 60 per provider, a 30-minute deadline per attempt and 3 attempts", async () => {
    bulkEnv();
    const runtime = await AdvancedRuntime.open(await mkdtemp(join(tmpdir(), "bulk-capacity-default-")));
    cleanups.push(() => runtime.close());
    expect(runtime.bulkCapacity()).toEqual({ defaultLimit: 60, providers: [], responseTimeoutMs: 1_800_000, retry: { attempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 } });
  });
});
