import { createServer, request } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDaemonServer } from "../../src/daemon/server.js";
import { makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

const TOKEN = "principals-test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const OWNER = "owner-key-0123456789abcdef";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

// Short data paths keep principal sockets inside the unix socket path limit.
const dataRoot = () => mkdtemp(join("/tmp", "pcp3d-"));
async function daemon(dataDir: string, token: string | null = TOKEN) {
  return await createDaemonServer({
    config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand(), ...(token != null ? { daemonAuthToken: token } : {}) }),
    dataDir,
    logger: quiet
  });
}
const body = (overrides: Record<string, unknown> = {}) => ({
  kind: "run", runId: "study-1", ownerKey: OWNER, socket: true,
  grants: { providers: ["judge"], instruments: [], maxConcurrency: 8, maxItems: 100, tokenBudget: { input: 1_000_000, output: null }, expiresAt: null },
  ...overrides
});
function unixGet(socketPath: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.once("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.once("error", reject);
    req.end();
  });
}

function unixPost(socketPath: string, path: string, value: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.once("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.once("error", reject);
    req.end(JSON.stringify(value));
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pcp/2 principals routes", () => {
  it("advertise principals with bearer authentication and report legacy attempt authority", async () => {
    const withToken = await daemon(await dataRoot());
    try {
      const capabilities = JSON.parse((await withToken.app.inject({ method: "GET", url: "/v2/capabilities", headers: auth })).body);
      expect(capabilities.features).toMatchObject({ principals: 1, legacyAttemptAuthority: 1, health: 1 });
    } finally {
      await withToken.app.close();
    }
    const open = await daemon(await dataRoot(), null);
    try {
      const capabilities = JSON.parse((await open.app.inject({ method: "GET", url: "/v2/capabilities" })).body);
      expect(capabilities.features).not.toHaveProperty("principals");
      const refused = await open.app.inject({ method: "PUT", url: "/v2/principals/run:study-1", payload: body() });
      expect(refused.statusCode).toBe(503);
      expect(JSON.parse(refused.body)).toMatchObject({ ok: false, code: "DAEMON_AUTH_REQUIRED", protocol: { major: 2 } });
    } finally {
      await open.app.close();
    }
    vi.stubEnv("PUPPENCLAW_LEGACY_ATTEMPT_AUTHORITY", "off");
    const strict = await daemon(await dataRoot());
    try {
      const capabilities = JSON.parse((await strict.app.inject({ method: "GET", url: "/v2/capabilities", headers: auth })).body);
      expect(capabilities.features.principals).toBe(1);
      expect(capabilities.features).not.toHaveProperty("legacyAttemptAuthority");
    } finally {
      await strict.app.close();
    }
  });

  it("fail startup on an invalid legacy flag or provider registry", async () => {
    vi.stubEnv("PUPPENCLAW_LEGACY_ATTEMPT_AUTHORITY", "sometimes");
    await expect(daemon(await dataRoot())).rejects.toThrow(/on or off/);
    vi.stubEnv("PUPPENCLAW_LEGACY_ATTEMPT_AUTHORITY", "on");
    vi.stubEnv("PUPPENCLAW_MODEL_PROVIDERS", "[{\"id\":\"no-model\"}]");
    await expect(daemon(await dataRoot())).rejects.toThrow(/PUPPENCLAW_MODEL_PROVIDERS/);
  });

  it("PUT is idempotent, GET reports usage and audit, DELETE revokes once; every response carries the envelope", async () => {
    vi.stubEnv("PUPPENCLAW_MODEL_PROVIDERS", JSON.stringify([{ id: "judge", model: "m", kind: "codex-openai-compatible", baseUrl: "http://127.0.0.1:9/v1", authTokenEnv: "UNSET_TEST_KEY" }]));
    const { app } = await daemon(await dataRoot());
    try {
      expect((await app.inject({ method: "PUT", url: "/v2/principals/run:study-1", payload: body() })).statusCode).toBe(401);
      const created = await app.inject({ method: "PUT", url: "/v2/principals/run:study-1", headers: auth, payload: body() });
      expect(created.statusCode).toBe(200);
      const view = JSON.parse(created.body);
      expect(view).toMatchObject({
        ok: true, protocol: { major: 2, minor: 0 }, principalId: "run:study-1", kind: "run", runId: "study-1",
        grants: { providers: ["judge"], maxConcurrency: 8, maxItems: 100 }, socketPath: expect.stringMatching(/broker\.sock$/u)
      });
      expect(view.bootId).toMatch(UUID);
      expect(view.spoolId).toMatch(UUID);
      expect(created.body).not.toContain(OWNER);
      const repeated = await app.inject({ method: "PUT", url: "/v2/principals/run:study-1", headers: auth, payload: body() });
      expect(repeated.body).toBe(created.body);

      const configs = await unixGet(view.socketPath, "/configs");
      expect(configs.body.authorization).toMatchObject({ principalId: "run:study-1", runId: "study-1" });
      expect(configs.body.workers).toEqual([expect.objectContaining({ id: "judge", bulkAvailable: true })]);

      const raised = await app.inject({ method: "PUT", url: "/v2/principals/run:study-1", headers: auth, payload: body({ grants: { ...body().grants, maxItems: 500 } }) });
      expect(JSON.parse(raised.body)).toMatchObject({ grants: { maxItems: 500 }, createdAt: view.createdAt });
      const detail = await app.inject({ method: "GET", url: "/v2/principals/run:study-1", headers: auth });
      expect(JSON.parse(detail.body)).toMatchObject({
        ok: true, protocol: { major: 2 }, state: "active", revokedAt: null, revision: 2, providersUnavailable: [],
        usage: { items: 0, inputTokens: 0, outputTokens: 0, activeItems: 0, remaining: { items: 500, inputTokens: 1_000_000, outputTokens: null } },
        audit: [expect.objectContaining({ action: "created" }), expect.objectContaining({ action: "updated" })]
      });
      expect(detail.body).not.toContain(OWNER);

      const conflict = await app.inject({ method: "PUT", url: "/v2/principals/run:study-1", headers: auth, payload: body({ runId: "study-2" }) });
      expect(conflict.statusCode).toBe(409);
      expect(JSON.parse(conflict.body)).toMatchObject({ ok: false, code: "PRINCIPAL_CONFLICT", protocol: { major: 2 } });
      const invalid = await app.inject({ method: "PUT", url: "/v2/principals/run:study-1", headers: auth, payload: { ...body(), grants: { providers: [] } } });
      expect(invalid.statusCode).toBe(400);
      expect(JSON.parse(invalid.body)).toMatchObject({ ok: false, code: "INVALID_PRINCIPAL", bootId: view.bootId });
      const unknown = await app.inject({ method: "GET", url: "/v2/principals/run:none", headers: auth });
      expect(unknown.statusCode).toBe(404);
      expect(JSON.parse(unknown.body)).toMatchObject({ ok: false, code: "PRINCIPAL_NOT_FOUND", spoolId: view.spoolId });

      const revoked = await app.inject({ method: "DELETE", url: "/v2/principals/run:study-1?cancel=1", headers: auth });
      expect(revoked.statusCode).toBe(200);
      const revocation = JSON.parse(revoked.body);
      expect(revocation).toMatchObject({ ok: true, principalId: "run:study-1", revokedAt: expect.any(String), protocol: { major: 2 } });
      const again = JSON.parse((await app.inject({ method: "DELETE", url: "/v2/principals/run:study-1", headers: auth })).body);
      expect(again.revokedAt).toBe(revocation.revokedAt);
      const reused = await app.inject({ method: "PUT", url: "/v2/principals/run:study-1", headers: auth, payload: body() });
      expect(reused.statusCode).toBe(409);
      expect(JSON.parse(reused.body).code).toBe("PRINCIPAL_REVOKED");
      expect((await app.inject({ method: "DELETE", url: "/v2/principals/run:none", headers: auth })).statusCode).toBe(404);
      await expect(unixGet(view.socketPath, "/configs")).rejects.toThrow();
    } finally {
      await app.close();
    }
  });

  it("reopen principal sockets when the daemon restarts", async () => {
    const dataDir = await dataRoot();
    const first = await daemon(dataDir);
    const socketPath = JSON.parse((await first.app.inject({ method: "PUT", url: "/v2/principals/run:study-1", headers: auth, payload: body() })).body).socketPath as string;
    await first.app.close();
    const second = await daemon(dataDir);
    try {
      expect((await unixGet(socketPath, "/configs")).body.authorization.principalId).toBe("run:study-1");
      const detail = JSON.parse((await second.app.inject({ method: "GET", url: "/v2/principals/run:study-1", headers: auth })).body);
      expect(detail).toMatchObject({ state: "active", socketPath });
    } finally {
      await second.app.close();
    }
  });

  it("still revoke while session state awaits an operator reset, and grant nothing then", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dataDir = await dataRoot();
    const first = await daemon(dataDir);
    await first.app.inject({ method: "PUT", url: "/v2/principals/run:study-1", headers: auth, payload: body() });
    await first.app.close();
    await writeFile(join(dataDir, "state.json"), "not json at all", "utf8");
    const { app } = await daemon(dataDir);
    try {
      const granted = await app.inject({ method: "PUT", url: "/v2/principals/run:study-2", headers: auth, payload: body({ runId: "study-2" }) });
      expect(granted.statusCode).toBe(503);
      expect(JSON.parse(granted.body).code).toBe("STATE_RECOVERY_REQUIRED");
      const revoked = await app.inject({ method: "DELETE", url: "/v2/principals/run:study-1", headers: auth });
      expect(revoked.statusCode).toBe(200);
      expect(JSON.parse((await app.inject({ method: "GET", url: "/v2/principals/run:study-1", headers: auth })).body).state).toBe("revoked");
    } finally {
      await app.close();
      vi.restoreAllMocks();
    }
  });

  it("report the owner's broker erasures that wait for the feed in the owner purge answer and in health until the acknowledgement", async () => {
    const upstream = createServer((req, res) => {
      req.resume();
      req.once("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: "test-model", output_text: "CONFIDENTIAL OUTPUT", usage: { input_tokens: 3, output_tokens: 1 } })); });
    });
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
    const port = (upstream.address() as { port: number }).port;
    vi.stubEnv("PUPPENCLAW_MODEL_PROVIDERS", JSON.stringify([{ id: "judge", model: "test-model", kind: "codex-openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, authTokenEnv: "PRINCIPAL_TEST_KEY" }]));
    vi.stubEnv("PRINCIPAL_TEST_KEY", "test-secret");
    const { app } = await daemon(await dataRoot());
    try {
      const socketPath = JSON.parse((await app.inject({ method: "PUT", url: "/v2/principals/run:study-1", headers: auth, payload: body() })).body).socketPath as string;
      const job = await unixPost(socketPath, "/bulk/submit?view=summary", { configId: "judge", idempotencyKey: "erasure", items: [{ id: "a", input: "CONFIDENTIAL INPUT" }] });
      expect(job.status).toBe(200);
      for (let i = 0; i < 400 && (await unixGet(socketPath, `/jobs/${job.body.jobId}?view=summary`)).body.state !== "completed"; i++) await new Promise((done) => setTimeout(done, 5));
      const health = async () => JSON.parse((await app.inject({ method: "GET", url: "/v2/health", headers: auth })).body).backlog.brokerErasures as number;
      expect(await health()).toBe(0);
      const purge = async () => JSON.parse((await app.inject({ method: "POST", url: "/sessions/owner/purge", headers: auth, payload: { ownerKey: OWNER, operationKey: "delete.account.erasure.0001" } })).body);
      const first = await purge();
      expect(first).toMatchObject({ ok: true, cleanup: { state: "purged" }, brokerErasuresPending: 1 });
      expect(await health()).toBe(1);
      // The feed reads the job's events, then acknowledges them: the erasure completes.
      const page = JSON.parse((await app.inject({ method: "GET", url: "/v2/events?after=0&limit=1000", headers: auth })).body);
      expect(JSON.stringify(page.events)).not.toContain("CONFIDENTIAL");
      expect((await app.inject({ method: "POST", url: "/v2/events/ack", headers: auth, payload: { feedId: page.feedId, through: page.head } })).statusCode).toBe(200);
      expect(await health()).toBe(0);
      expect(await purge()).toMatchObject({ ok: true, cleanup: { state: "purged" }, brokerErasuresPending: 0 });
    } finally {
      await app.close();
      upstream.closeAllConnections();
      await new Promise<void>((done) => upstream.close(() => done()));
    }
  });

  it("revoke an owner's principals during account purge and bind compute jobs only to live principal sockets", async () => {
    const { app } = await daemon(await dataRoot());
    try {
      await app.inject({ method: "PUT", url: "/v2/principals/run:study-1", headers: auth, payload: body() });
      const unbound = await app.inject({
        method: "POST", url: "/compute/jobs", headers: auth,
        payload: { jobId: "principal-job", executor: "bubblewrap-local", command: ["true"], cwd: "/tmp", resources: { cpuCores: 1, memoryMiB: 128, wallTimeSeconds: 5 }, principalId: "run:none" }
      });
      expect(unbound.statusCode).toBe(400);
      const purged = await app.inject({ method: "POST", url: "/sessions/owner/purge", headers: auth, payload: { ownerKey: OWNER, operationKey: "delete.account.p3.0001" } });
      expect(purged.statusCode).toBe(200);
      // Revoked, then erased to a tombstone: no run binding, grants, usage or audit survive the account.
      expect(JSON.parse((await app.inject({ method: "GET", url: "/v2/principals/run:study-1", headers: auth })).body))
        .toMatchObject({ state: "revoked", runId: null, grants: { providers: [] }, usage: { items: 0 }, audit: [] });
    } finally {
      await app.close();
    }
  });
});
