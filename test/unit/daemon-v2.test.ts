import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventLoopMonitor } from "../../src/daemon/event-loop.js";
import { resolveBuildId } from "../../src/daemon/identity.js";
import { createDaemonServer } from "../../src/daemon/server.js";
import { SessionStore } from "../../src/shared/store.js";
import {
  createTempDir,
  makeConfig,
  resolveFakeAcpxCommand,
  seedSession,
  seedTranscript,
  writeSeedState
} from "../helpers.js";

const TOKEN = "v2-test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function daemon(dataDir: string, token: string | null = TOKEN) {
  return await createDaemonServer({
    config: makeConfig({
      acpxCommand: await resolveFakeAcpxCommand(),
      ...(token != null ? { daemonAuthToken: token } : {})
    }),
    dataDir,
    logger: quiet
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pcp/2 health and identity", () => {
  it("serves an authenticated health payload under 1 KB with identity, backlog and event-loop lag", async () => {
    const dataDir = await createTempDir("puppenclaw-v2-health-");
    const { app } = await daemon(dataDir);
    try {
      expect((await app.inject({ method: "GET", url: "/v2/health" })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: "GET", url: "/v2/health", headers: { authorization: "Bearer nope" } }))
          .statusCode
      ).toBe(401);
      const response = await app.inject({ method: "GET", url: "/v2/health", headers: auth });
      expect(response.statusCode).toBe(200);
      expect(Buffer.byteLength(response.body)).toBeLessThan(1024);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(body).toMatchObject({
        ok: true,
        protocol: { major: 2, minor: 0 },
        stateRecovery: { required: false },
        activeTurns: 0,
        backlog: { streams: 0, streamEvents: 0, streamBytes: 0, stateWrites: 0, brokerErasures: 0 },
        eventLoop: { windowMs: 30_000 }
      });
      expect(body.bootId).toMatch(UUID);
      expect(body.spoolId).toMatch(UUID);
      expect(body.build).toMatch(/^[0-9A-Za-z.-]+\+[0-9a-f]{12}$/u);
      expect(typeof (body.eventLoop as { p99Ms: number }).p99Ms).toBe("number");
      expect(body.memory).toMatchObject({
        rssBytes: expect.any(Number) as number,
        heapUsedBytes: expect.any(Number) as number,
        heapLimitBytes: expect.any(Number) as number
      });
      expect(response.headers["x-puppenclaw-boot-id"]).toBe(body.bootId);
      expect(response.headers["x-puppenclaw-spool-id"]).toBe(body.spoolId);
      expect(response.headers["x-puppenclaw-protocol"]).toBe("2.0");
    } finally {
      await app.close();
    }
  });

  it("keeps health constant-cost: under 1 KB and within 10 ms with a large session store", async () => {
    const dataDir = await createTempDir("puppenclaw-v2-health-large-");
    const workspace = await createTempDir("puppenclaw-v2-health-large-ws-");
    // About 10 MB of transcripts across 200 sessions, the size of the production store.
    await writeSeedState(
      dataDir,
      Array.from({ length: 200 }, (_, index) =>
        seedSession(`lab-${index}`, workspace, { transcript: seedTranscript(50, 1_000) })
      )
    );
    const { app } = await daemon(dataDir);
    try {
      const durations: number[] = [];
      let body = "";
      for (let index = 0; index < 60; index += 1) {
        const startedAt = performance.now();
        const response = await app.inject({ method: "GET", url: "/v2/health", headers: auth });
        durations.push(performance.now() - startedAt);
        expect(response.statusCode).toBe(200);
        body = response.body;
      }
      durations.sort((left, right) => left - right);
      const median = durations[Math.floor(durations.length / 2)]!;
      const p90 = durations[Math.floor(durations.length * 0.9)]!;
      expect(Buffer.byteLength(body)).toBeLessThan(1024);
      expect(median).toBeLessThanOrEqual(10);
      expect(p90).toBeLessThanOrEqual(10);
      // For contrast: the legacy probe serialises every transcript.
      const legacy = await app.inject({ method: "GET", url: "/sessions", headers: auth });
      expect(Buffer.byteLength(legacy.body)).toBeGreaterThan(10_000_000);
    } finally {
      await app.close();
    }
  }, 60_000);

  it("adds identity headers to every response, open, legacy and rejected ones included", async () => {
    const dataDir = await createTempDir("puppenclaw-v2-headers-");
    const { app } = await daemon(dataDir);
    try {
      const health = JSON.parse(
        (await app.inject({ method: "GET", url: "/v2/health", headers: auth })).body
      ) as { bootId: string; spoolId: string };
      for (const request of [
        { method: "GET" as const, url: "/health" },
        { method: "GET" as const, url: "/capabilities" },
        { method: "GET" as const, url: "/sessions" },
        { method: "GET" as const, url: "/sessions", headers: auth },
        { method: "GET" as const, url: "/session/missing", headers: auth }
      ]) {
        const response = await app.inject(request);
        expect(response.headers["x-puppenclaw-protocol"], request.url).toBe("2.0");
        expect(response.headers["x-puppenclaw-boot-id"], request.url).toBe(health.bootId);
        expect(response.headers["x-puppenclaw-spool-id"], request.url).toBe(health.spoolId);
      }
      // v1 bodies keep their shape.
      expect(JSON.parse((await app.inject({ method: "GET", url: "/health" })).body)).toEqual({
        ok: true,
        sessions: 0,
        stateRecovery: { required: false }
      });
    } finally {
      await app.close();
    }
  });

  it("changes bootId on every start and keeps spoolId for continued state", async () => {
    const dataDir = await createTempDir("puppenclaw-v2-spool-");
    const workspace = await createTempDir("puppenclaw-v2-spool-ws-");
    const read = async (app: Awaited<ReturnType<typeof daemon>>["app"]) =>
      JSON.parse((await app.inject({ method: "GET", url: "/v2/health", headers: auth })).body) as {
        bootId: string;
        spoolId: string;
      };

    const first = await daemon(dataDir);
    const one = await read(first.app);
    // A fresh data directory has no spool file until state is first written.
    await expect(readFile(join(dataDir, "spool.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const started = await first.app.inject({
      method: "POST",
      url: "/session/start",
      headers: auth,
      payload: { agent: "claude", name: "spool-demo", directory: workspace, task: "hello" }
    });
    expect(started.statusCode).toBe(200);
    expect(JSON.parse(await readFile(join(dataDir, "spool.json"), "utf8"))).toMatchObject({
      version: 1,
      spoolId: one.spoolId
    });
    await first.app.close();

    const second = await daemon(dataDir);
    const two = await read(second.app);
    await second.app.close();
    expect(two.bootId).not.toBe(one.bootId);
    expect(two.spoolId).toBe(one.spoolId);

    const other = await daemon(await createTempDir("puppenclaw-v2-spool-other-"));
    const three = await read(other.app);
    await other.app.close();
    expect(three.spoolId).not.toBe(one.spoolId);
  });

  it("starts a new spool when state must be recovered and again on the operator reset", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = await createTempDir("puppenclaw-v2-spool-recovery-");
    const healthy = await SessionStore.open(dir);
    await healthy.flush();
    const original = healthy.spoolId;
    await healthy.close();

    await writeFile(join(dir, "state.json"), "{broken", "utf8");
    const recovering = await SessionStore.open(dir);
    expect(recovering.getRecoveryStatus().required).toBe(true);
    expect(recovering.spoolId).not.toBe(original);
    await recovering.resetRecovery();
    const resetSpool = recovering.spoolId;
    expect(resetSpool).not.toBe(original);
    await recovering.close();

    const reopened = await SessionStore.open(dir);
    expect(reopened.spoolId).toBe(resetSpool);
    await reopened.close();
    vi.restoreAllMocks();
  });

  it("advertises pcp/2 capabilities with provider dialect limits behind authentication", async () => {
    const dataDir = await createTempDir("puppenclaw-v2-capabilities-");
    const { app } = await daemon(dataDir);
    try {
      expect((await app.inject({ method: "GET", url: "/v2/capabilities" })).statusCode).toBe(401);
      const response = await app.inject({ method: "GET", url: "/v2/capabilities", headers: auth });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(body).toMatchObject({
        ok: true,
        protocol: { major: 2, minor: 0 },
        pcp: { major: 2, minor: 0 },
        features: { health: 1, opsIdle: 1, usageLedger: 1, compactStatus: 1, keyedStreaming: 1 },
        limits: { turnKeyMax: 128, ledgerPageMax: 1_000, transcriptLimitMax: 1_000, transcriptPageMax: 500 },
        providers: {
          structuredOutput: [
            { reasoningProfile: "qwen-3.8", unsupportedKeywords: ["uniqueItems"] }
          ]
        }
      });
      expect(body.bootId).toMatch(UUID);
      // The open v1 capabilities document gains no new flags.
      const legacy = JSON.parse((await app.inject({ method: "GET", url: "/capabilities" })).body) as Record<string, unknown>;
      expect(legacy).not.toHaveProperty("features");
      expect(legacy).not.toHaveProperty("bootId");
    } finally {
      await app.close();
    }
  });

  it("stays open like every other route when no token is configured", async () => {
    const { app } = await daemon(await createTempDir("puppenclaw-v2-open-"), null);
    try {
      expect((await app.inject({ method: "GET", url: "/v2/health" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("build id and event-loop monitor", () => {
  it("prefers PUPPENCLAW_BUILD_ID and otherwise derives version plus bundle digest", async () => {
    expect(await resolveBuildId({ PUPPENCLAW_BUILD_ID: "c36cfa2+release" })).toBe("c36cfa2+release");
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(await resolveBuildId({ PUPPENCLAW_BUILD_ID: "bad id with spaces" })).toMatch(
      new RegExp(`^${pkg.version.replaceAll(".", "\\.")}\\+[0-9a-f]{12}$`, "u")
    );
  });

  it("reports lag beyond the tick and keeps the last window's stall visible", async () => {
    const monitor = new EventLoopMonitor({ resolutionMs: 10, windowMs: 60_000 });
    monitor.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const idle = monitor.snapshot();
      expect(idle.p99Ms).toBeLessThan(50);
      const blockedUntil = Date.now() + 150;
      while (Date.now() < blockedUntil) {
        // Block the event loop.
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(monitor.snapshot().maxMs).toBeGreaterThanOrEqual(120);
      monitor.rotate();
      expect(monitor.snapshot().maxMs).toBeGreaterThanOrEqual(120);
    } finally {
      monitor.stop();
    }
  });
});
