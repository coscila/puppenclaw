import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { AdvancedRuntime } from "../../src/advanced/runtime.js";
import type { WorkerJob } from "../../src/advanced/types.js";
import { createDaemonServer } from "../../src/daemon/server.js";
import { registerV2BrokerRoutes } from "../../src/daemon/v2-broker.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

const TOKEN = "v2-broker-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function daemon(dataDir: string) {
  const { app } = await createDaemonServer({ config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand(), daemonAuthToken: TOKEN }), dataDir, logger: quiet });
  return app;
}

/** The broker routes over a real runtime, without the session manager. */
async function brokerApp() {
  const runtime = await AdvancedRuntime.open(await createTempDir("v2-broker-runtime-"));
  const app = Fastify({ logger: false });
  registerV2BrokerRoutes(app, { identity: { bootId: "boot-1", build: "test", startedAt: new Date().toISOString(), startedAtMs: Date.now(), spoolId: () => "spool-1" }, advanced: runtime });
  cleanups.push(async () => { await app.close(); await runtime.close(); });
  return { app, runtime };
}

function job(id: string): WorkerJob {
  return {
    jobId: id, kind: "bulk", state: "queued", parentSessionName: "parent", attemptId: "attempt", configRevision: 1,
    config: { id: "refs", assignment: "Review", agent: "codex", modelProvider: { id: "local", model: "test", kind: "codex-openai-compatible" } },
    idempotencyKey: id, fingerprint: id, createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z",
    request: { configId: "refs", idempotencyKey: id, concurrency: 1, items: [{ id: "one", input: "x" }] },
    results: [{ id: "one", state: "queued", providerId: "local", model: "test", promptSha256: "p", usage: null }]
  };
}

const instrument = {
  instrumentId: "citation-census@1", version: 1, systemPrompt: "Judge each entry.", responseSchema: { type: "object" },
  maxOutputTokens: { perItem: 700, minimum: 3000 }, temperature: 0, seed: null, reasoning: "none", itemsPerCall: 40, requiredModelFingerprint: null
};
const envelope = { protocol: { major: 2, minor: 0 }, bootId: expect.any(String) as string, spoolId: expect.any(String) as string };

describe("pcp/2 broker routes on the daemon", () => {
  it("authenticates every route, advertises the features and keeps installed instruments across a restart", async () => {
    const dataDir = await createTempDir("v2-broker-daemon-");
    let app = await daemon(dataDir);
    try {
      for (const [method, url] of [["GET", "/v2/events"], ["POST", "/v2/events/ack"], ["GET", "/v2/instruments"], ["PUT", "/v2/instruments/abc"]] as const) {
        expect((await app.inject(method === "GET" ? { method, url } : { method, url, payload: {} })).statusCode, `${method} ${url}`).toBe(401);
      }
      const capabilities = JSON.parse((await app.inject({ method: "GET", url: "/v2/capabilities", headers: auth })).body) as { features: Record<string, number>; limits: Record<string, number> };
      expect(capabilities.features).toMatchObject({ eventFeed: 1, brokerOutbox: 1, instrumentMode: 1 });
      expect(capabilities.limits).toMatchObject({ eventPageMax: 1000, eventWaitMsMax: 25_000, eventInlineOutputMax: 16_384 });
      const empty = JSON.parse((await app.inject({ method: "GET", url: "/v2/events", headers: auth })).body) as Record<string, unknown>;
      expect(empty).toEqual({ ok: true, ...envelope, feedId: expect.any(String), events: [], next: 0, hasMore: false, head: 0, acked: 0 });
      const installed = await app.inject({ method: "PUT", url: "/v2/instruments/digest-abc", headers: auth, payload: instrument });
      expect(installed.statusCode).toBe(200);
      expect(JSON.parse(installed.body)).toEqual({ ok: true, ...envelope, digest: "digest-abc", settingsSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
      const again = await app.inject({ method: "PUT", url: "/v2/instruments/digest-abc", headers: auth, payload: instrument });
      expect(JSON.parse(again.body).settingsSha256).toBe(JSON.parse(installed.body).settingsSha256);
      const conflict = await app.inject({ method: "PUT", url: "/v2/instruments/digest-abc", headers: auth, payload: { ...instrument, temperature: 1 } });
      expect(conflict.statusCode).toBe(409); expect(JSON.parse(conflict.body)).toMatchObject({ ok: false, code: "INSTRUMENT_DIGEST_CONFLICT", ...envelope });
      const invalid = await app.inject({ method: "PUT", url: "/v2/instruments/digest-def", headers: auth, payload: { ...instrument, reasoning: "loud", extra: 1 } });
      expect(invalid.statusCode).toBe(400); expect(JSON.parse(invalid.body)).toMatchObject({ code: "INVALID_INSTRUMENT" });
      const badSchema = await app.inject({ method: "PUT", url: "/v2/instruments/digest-def", headers: auth, payload: { ...instrument, responseSchema: { type: 12 } } });
      expect(badSchema.statusCode).toBe(400); expect(JSON.parse(badSchema.body)).toMatchObject({ code: "INVALID_INSTRUMENT" });
      expect((await app.inject({ method: "PUT", url: "/v2/instruments/bad%20digest", headers: auth, payload: instrument })).statusCode).toBe(400);
    } finally { await app.close(); }
    app = await daemon(dataDir);
    try {
      const listed = JSON.parse((await app.inject({ method: "GET", url: "/v2/instruments", headers: auth })).body) as Record<string, unknown>;
      expect(listed).toMatchObject({ ok: true, ...envelope, digests: ["digest-abc"], instruments: [{ digest: "digest-abc", instrumentId: "citation-census@1", version: 1, itemsPerCall: 40 }] });
    } finally { await app.close(); }
  });
});

describe("GET /v2/events and POST /v2/events/ack", () => {
  it("pages events, refuses foreign cursors and acknowledges durably without moving backwards", async () => {
    const { app, runtime } = await brokerApp();
    for (let index = 0; index < 3; index += 1) runtime.store.createJob(job(`j${index}`));
    const page = JSON.parse((await app.inject({ method: "GET", url: "/v2/events?after=0&limit=2" })).body) as { feedId: string; events: { seq: number; type: string; jobId: string; at: string; payload: Record<string, unknown> }[]; next: number; hasMore: boolean; head: number; acked: number };
    expect(page).toMatchObject({ ok: true, protocol: { major: 2, minor: 0 }, bootId: "boot-1", spoolId: "spool-1", next: 2, hasMore: true, head: 3, acked: 0 });
    expect(page.events.map((event) => [event.seq, event.type, event.jobId])).toEqual([[1, "broker.job", "j0"], [2, "broker.job", "j1"]]);
    expect(page.events[0]).not.toHaveProperty("itemId");
    expect(page.events[0]!.payload).toMatchObject({ jobId: "j0", state: "queued", counts: { total: 1, queued: 1 } });
    const beyond = await app.inject({ method: "GET", url: "/v2/events?after=4" });
    expect(beyond.statusCode).toBe(400); expect(JSON.parse(beyond.body)).toMatchObject({ ok: false, code: "INVALID_EVENT_CURSOR", bootId: "boot-1", spoolId: "spool-1" });
    expect(JSON.parse((await app.inject({ method: "GET", url: "/v2/events?after=-1" })).body).code).toBe("INVALID_EVENT_CURSOR");
    expect(JSON.parse((await app.inject({ method: "GET", url: "/v2/events?limit=1001" })).body).code).toBe("INVALID_PARAMS");
    expect(JSON.parse((await app.inject({ method: "GET", url: "/v2/events?waitMs=25001" })).body).code).toBe("INVALID_PARAMS");
    const ack = (feedId: string, through: number) => app.inject({ method: "POST", url: "/v2/events/ack", payload: { feedId, through } });
    expect(JSON.parse((await ack(page.feedId, 2)).body)).toEqual({ ok: true, protocol: { major: 2, minor: 0 }, bootId: "boot-1", spoolId: "spool-1", acked: 2 });
    expect(JSON.parse((await ack(page.feedId, 1)).body).acked).toBe(2);
    const replaced = await ack("another-feed", 3);
    expect(replaced.statusCode).toBe(409); expect(JSON.parse(replaced.body)).toMatchObject({ code: "FEED_REPLACED", retryable: false });
    const ahead = await ack(page.feedId, 9);
    expect(ahead.statusCode).toBe(400); expect(JSON.parse(ahead.body).code).toBe("INVALID_EVENT_CURSOR");
    expect((await app.inject({ method: "POST", url: "/v2/events/ack", payload: { feedId: page.feedId, through: "x" } })).statusCode).toBe(400);
    expect(JSON.parse((await app.inject({ method: "GET", url: "/v2/events?after=2" })).body)).toMatchObject({ acked: 2, events: [{ seq: 3 }] });
  });

  it("long-polls until an event commits and returns at once when one exists", async () => {
    const { app, runtime } = await brokerApp();
    const started = Date.now();
    const pending = app.inject({ method: "GET", url: "/v2/events?after=0&waitMs=5000" });
    setTimeout(() => runtime.store.createJob(job("late")), 100);
    const page = JSON.parse((await pending).body) as { events: { jobId: string }[] };
    expect(page.events.map((event) => event.jobId)).toEqual(["late"]);
    expect(Date.now() - started).toBeLessThan(3_000);
    const immediate = Date.now();
    await app.inject({ method: "GET", url: "/v2/events?after=0&waitMs=5000" });
    expect(Date.now() - immediate).toBeLessThan(500);
    const empty = Date.now();
    expect(JSON.parse((await app.inject({ method: "GET", url: "/v2/events?after=1&waitMs=150" })).body).events).toEqual([]);
    expect(Date.now() - empty).toBeGreaterThanOrEqual(140);
  });
});
