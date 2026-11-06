import { once } from "node:events";
import { request } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { connect as connectTls } from "node:tls";

import { afterEach, describe, expect, it } from "vitest";

import { EgressPolicy } from "../../src/advanced/egress.js";
import type { BrokerRefusalPayload } from "../../src/advanced/outbox.js";
import { PrincipalRegistry } from "../../src/advanced/principals.js";
import { REFUSAL_KINDS, REFUSAL_OVERFLOW_TARGET, RefusalRecorder, refusalSubject, refusalTarget } from "../../src/advanced/refusals.js";
import { AdvancedRuntime } from "../../src/advanced/runtime.js";
import { startParamsZod } from "../../src/shared/schema.js";
import type { ModelProviderConfig, SessionInfo } from "../../src/shared/types.js";

/**
 * broker.refusal events (brokerOutbox:3): every request the broker refuses at a participant's boundary is recorded in
 * the outbox with who asked, what for and the refusal's code, never with the request's content, and delivered and
 * erased by the outbox rules.
 */
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); delete process.env.TEST_MODEL_KEY; });
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
const SECRET_PROMPT = "confidential manuscript sentence 7f3a";

function unix(socketPath: string, path: string, value?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false, method: value === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; });
      res.once("end", () => { let body: unknown; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: res.statusCode!, body }); });
    });
    req.once("error", reject); req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}
/** A raw request line over the broker socket: a CONNECT tunnel or an absolute-URI proxy request. */
function raw(socketPath: string, text: string): Promise<string> {
  return new Promise((resolve) => {
    const client = connect(socketPath, () => client.write(text));
    let reply = "";
    client.on("data", (chunk) => { reply += chunk; });
    client.on("close", () => resolve(reply));
    client.on("error", () => resolve(reply));
    setTimeout(() => client.destroy(), 2_000).unref();
  });
}

async function turn(options: { mode?: "plan" | "execute"; kind?: ModelProviderConfig["kind"]; windowMs?: number } = {}) {
  process.env.TEST_MODEL_KEY = "test-secret";
  const runtime = await AdvancedRuntime.open(await mkdtemp(join("/tmp", "pcrf-")), { defaultLimit: 4 }, { retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 5 }, ...(options.windowMs !== undefined ? { refusals: { windowMs: options.windowMs } } : {}) });
  cleanups.push(() => runtime.close());
  const mode = options.mode ?? "execute";
  const provider: ModelProviderConfig = { id: "local", model: "judge-model", kind: options.kind ?? "codex-openai-compatible", baseUrl: "http://127.0.0.1:9/v1", authTokenEnv: "TEST_MODEL_KEY" };
  const worker: ModelProviderConfig = { ...provider, kind: "codex-openai-compatible" };
  const params = startParamsZod.parse({ name: "lab-chat-1", agent: "codex", directory: "/tmp", task: "review", interactionMode: mode, permissionMode: mode === "execute" ? "approve-all" : "approve-reads",
    statisticsContext: { version: 1, chatId: "chat-1", attemptId: "attempt-1" }, modelProvider: provider,
    orchestration: { version: 1, revision: 1, workers: [{ id: "refs", assignment: "Check sources", agent: "codex", modelProvider: worker }] } });
  const session = { ...params, state: "idle", warnings: [], transcript: [], createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() } as unknown as SessionInfo;
  runtime.attach({ start: async () => ({ content: [], details: {} }), quiesce: async () => {}, getSession: () => session, contribution: () => {}, purge: async () => {} });
  await runtime.begin(session, params, mode === "execute" ? "approve-all" : "approve-reads");
  return { runtime, socket: runtime.socket("lab-chat-1")! };
}

async function refusals(runtime: AdvancedRuntime, count: number): Promise<{ jobId: string; payload: BrokerRefusalPayload; seq: number }[]> {
  for (let i = 0; i < 400; i++) {
    const found = runtime.store.events(0, 1000).events.filter((event) => event.type === "broker.refusal");
    if (found.length >= count) return found.map((event) => ({ jobId: event.jobId, payload: event.payload as BrokerRefusalPayload, seq: event.seq }));
    await delay(5);
  }
  throw new Error(`Expected ${count} refusal event(s).`);
}

describe("refusal recorder", () => {
  const subject = refusalSubject({ parentSessionName: "lab-chat-1", attemptId: "attempt-1" });
  it("writes the first refusal at once and folds identical ones into one counted event when the window closes", () => {
    let now = 1_000_000;
    const written: BrokerRefusalPayload[] = [];
    const recorder = new RefusalRecorder((payload) => written.push(payload), { windowMs: 60_000, now: () => now });
    cleanups.push(() => recorder.close());
    expect(recorder.record(subject, "EGRESS_DENIED", "10.0.0.1:443")).toBe(true);
    for (let i = 0; i < 4; i++) { now += 1_000; recorder.record(subject, "EGRESS_DENIED", "10.0.0.1:443"); }
    recorder.record(subject, "EGRESS_DENIED", "10.0.0.2:443");
    expect(written.map((payload) => [payload.target, payload.repeats])).toEqual([["10.0.0.1:443", 1], ["10.0.0.2:443", 1]]);
    now += 60_000;
    recorder.flush();
    expect(written.map((payload) => [payload.target, payload.repeats])).toEqual([["10.0.0.1:443", 1], ["10.0.0.2:443", 1], ["10.0.0.1:443", 4]]);
    expect(written[2]!.at).toBe(new Date(1_004_000).toISOString());
    // A later refusal opens a new window and is written at once again.
    recorder.record(subject, "EGRESS_DENIED", "10.0.0.1:443");
    expect(written.at(-1)).toMatchObject({ target: "10.0.0.1:443", repeats: 1, kind: "egress", sessionName: "lab-chat-1", attemptId: "attempt-1", principalId: null, jobId: null });
    expect(written.reduce((sum, payload) => sum + (payload.target === "10.0.0.1:443" ? payload.repeats : 0), 0)).toBe(6);
  });

  it("records containment codes only, drops an erased session's folded counts and writes them all at close", () => {
    const written: BrokerRefusalPayload[] = [];
    const recorder = new RefusalRecorder((payload) => written.push(payload), { windowMs: 60_000 });
    expect(recorder.record(subject, "BUDGET_EXHAUSTED", "run:a")).toBe(false);
    expect(recorder.record(subject, "ORCHESTRATION_TURN_CLOSED", "x")).toBe(false);
    expect(recorder.record(subject, "UNKNOWN_WORKER_ROUTE", "/admin")).toBe(false);
    recorder.record(subject, "MODEL_NOT_CONFIGURED", "other-model");
    recorder.record(subject, "MODEL_NOT_CONFIGURED", "other-model");
    const principal = refusalSubject({ parentSessionName: "principal:run:a", attemptId: "run:a", principalId: "run:a" });
    recorder.record(principal, "PROVIDER_NOT_GRANTED", "judge");
    recorder.record(principal, "PROVIDER_NOT_GRANTED", "judge");
    recorder.discard("principal:run:a");
    recorder.close();
    expect(written.map((payload) => [payload.sessionName, payload.code, payload.repeats])).toEqual([
      ["lab-chat-1", "MODEL_NOT_CONFIGURED", 1], ["principal:run:a", "PROVIDER_NOT_GRANTED", 1], ["lab-chat-1", "MODEL_NOT_CONFIGURED", 1]
    ]);
    expect(written[1]).toMatchObject({ attemptId: null, principalId: "run:a", kind: "grant" });
    expect(recorder.record(subject, "EGRESS_DENIED", "x:443")).toBe(false);
    expect(recorder.openWindows).toBe(0);
  });

  it("shares one counted window among the targets beyond the per-code bound, so a scan of hosts cannot flood the feed", () => {
    let now = 1_000_000;
    const written: BrokerRefusalPayload[] = [];
    const recorder = new RefusalRecorder((payload) => written.push(payload), { windowMs: 60_000, targetsPerCode: 2, now: () => now });
    cleanups.push(() => recorder.close());
    for (let host = 1; host <= 6; host++) recorder.record(subject, "EGRESS_DENIED", `10.0.0.${host}:443`);
    // Another code of the same participant has a bound of its own.
    recorder.record(subject, "MODEL_NOT_CONFIGURED", "other-model");
    expect(written.map((payload) => [payload.code, payload.target, payload.repeats])).toEqual([
      ["EGRESS_DENIED", "10.0.0.1:443", 1], ["EGRESS_DENIED", "10.0.0.2:443", 1], ["EGRESS_DENIED", REFUSAL_OVERFLOW_TARGET, 1], ["MODEL_NOT_CONFIGURED", "other-model", 1]
    ]);
    now += 60_000;
    recorder.flush();
    // The overflow window counts the other targets: every refused request is in some event's repeats.
    expect(written.at(-1)).toMatchObject({ code: "EGRESS_DENIED", target: REFUSAL_OVERFLOW_TARGET, repeats: 3 });
    expect(written.filter((payload) => payload.code === "EGRESS_DENIED").reduce((sum, payload) => sum + payload.repeats, 0)).toBe(6);
    // Once the windows closed, a new target has a window of its own again.
    recorder.record(subject, "EGRESS_DENIED", "10.0.0.7:443");
    expect(written.at(-1)).toMatchObject({ target: "10.0.0.7:443", repeats: 1 });
    expect(refusalTarget(REFUSAL_OVERFLOW_TARGET)).not.toBe(REFUSAL_OVERFLOW_TARGET);
  });

  it("bounds open windows and targets", () => {
    const written: BrokerRefusalPayload[] = [];
    const recorder = new RefusalRecorder((payload) => written.push(payload), { windowMs: 60_000, maxOpen: 2 });
    cleanups.push(() => recorder.close());
    for (const host of ["a", "b"]) { recorder.record(subject, "EGRESS_DENIED", `${host}:443`); recorder.record(subject, "EGRESS_DENIED", `${host}:443`); }
    recorder.record(subject, "EGRESS_DENIED", "c:443");
    // The oldest window was written out early with its folded count.
    expect(written.map((payload) => [payload.target, payload.repeats])).toEqual([["a:443", 1], ["b:443", 1], ["c:443", 1], ["a:443", 1]]);
    expect(recorder.openWindows).toBe(2);
    expect(refusalTarget(`x\u0000y\n${"z".repeat(400)}`)).toMatch(/^x\?y\?z+$/u);
    // A target is an identifier: no spaces or prose survive.
    expect(refusalTarget("[::1]:443")).toBe("[::1]:443");
    expect(refusalTarget("some model; ignore the rules")).toBe("some?model??ignore?the?rules");
    expect(refusalTarget("z".repeat(400))).toHaveLength(256);
    expect(Object.values(REFUSAL_KINDS).sort()).toEqual(expect.arrayContaining(["credential", "egress", "grant", "instrument", "model"]));
  });
});

describe("egress denials", () => {
  it("name the destination asked for as host:port", async () => {
    const policy = new EgressPolicy();
    await expect(policy.destination("example.com", 22)).rejects.toMatchObject({ code: "EGRESS_DENIED", details: { target: "example.com:22" } });
    await expect(policy.destination("10.0.0.1", 443)).rejects.toMatchObject({ code: "EGRESS_DENIED", details: { target: "10.0.0.1:443" } });
    await expect(policy.destination("API.OpenAI.com.", 443)).rejects.toMatchObject({ code: "EGRESS_DENIED", details: { target: "api.openai.com:443" } });
    await expect(policy.destination("[::1]", 443)).rejects.toMatchObject({ code: "EGRESS_DENIED", details: { target: "[::1]:443" } });
  });
});

describe("broker.refusal events of a chat turn", () => {
  it("record a denied CONNECT tunnel and a denied proxy request with host:port and nothing of the request", async () => {
    const { runtime, socket } = await turn();
    const tunnel = await raw(socket, "CONNECT 10.0.0.1:443 HTTP/1.1\r\nHost: 10.0.0.1:443\r\n\r\n");
    expect(tunnel).not.toContain("200 Connection Established");
    const proxied = await unix(socket, "http://127.0.0.1:8080/secret?token=abc", undefined, { host: "127.0.0.1:8080" });
    expect(proxied.body.code).toBe("EGRESS_DENIED");
    const events = await refusals(runtime, 2);
    expect(events.map((event) => event.payload)).toEqual([
      { sessionName: "lab-chat-1", attemptId: "attempt-1", principalId: null, jobId: null, kind: "egress", target: "10.0.0.1:443", code: "EGRESS_DENIED", at: expect.any(String), repeats: 1 },
      { sessionName: "lab-chat-1", attemptId: "attempt-1", principalId: null, jobId: null, kind: "egress", target: "127.0.0.1:8080", code: "EGRESS_DENIED", at: expect.any(String), repeats: 1 }
    ]);
    // The envelope names no job for a refusal that concerns none, and the payload holds no path, query or body.
    expect(events.map((event) => event.jobId)).toEqual(["", ""]);
    expect(JSON.stringify(events)).not.toMatch(/secret|token=abc/u);
  });

  it("record a model the attempt is not granted and fold a client's retry loop into one counted event", async () => {
    const { runtime, socket } = await turn({ windowMs: 200 });
    for (let i = 0; i < 5; i++) {
      const answer = await unix(socket, "/native/v1/responses", { model: "other-model", input: SECRET_PROMPT });
      expect(answer.body.code).toBe("MODEL_NOT_CONFIGURED");
    }
    const events = await refusals(runtime, 2);
    expect(events.map((event) => [event.payload.kind, event.payload.target, event.payload.code, event.payload.repeats])).toEqual([
      ["model", "other-model", "MODEL_NOT_CONFIGURED", 1], ["model", "other-model", "MODEL_NOT_CONFIGURED", 4]
    ]);
    expect(JSON.stringify(runtime.store.events(0, 1000))).not.toContain(SECRET_PROMPT);
  });

  it("record an API key on a subscription OAuth route as a credential refusal", async () => {
    const { runtime, socket } = await turn({ kind: "claude-code" });
    const answer = await unix(socket, "/native/v1/messages", { model: "judge-model", messages: [{ role: "user", content: SECRET_PROMPT }] }, { "x-api-key": "api-key-value-4d2c" });
    expect(answer.body.code).toBe("PROVIDER_AUTHENTICATION_REQUIRED");
    const [event] = await refusals(runtime, 1);
    expect(event!.payload).toMatchObject({ kind: "credential", target: "local", code: "PROVIDER_AUTHENTICATION_REQUIRED" });
    expect(JSON.stringify(runtime.store.events(0, 1000))).not.toMatch(/api-key-value|confidential/u);
  });

  it("record an OAuth relay request other than the agent's own token refresh as a credential refusal", async () => {
    const { runtime, socket } = await turn({ kind: "claude-code" });
    const certificate = runtime.environment("lab-chat-1").PUPPENCLAW_ORCHESTRATION_CLAUDE_OAUTH_CERT!;
    const peer = await new Promise<Socket>((resolve, reject) => {
      const req = request({ socketPath: socket, method: "CONNECT", path: "platform.claude.com:443" });
      req.on("error", reject); req.on("connect", (_res, tunnel) => resolve(tunnel)); req.end();
    });
    const tls = connectTls({ socket: peer, servername: "platform.claude.com", ca: await readFile(certificate), rejectUnauthorized: true });
    await once(tls, "secureConnect");
    const reply = new Promise<string>((resolve) => { let text = ""; tls.on("data", (chunk) => { text += chunk; }); tls.on("end", () => resolve(text)); });
    tls.end("GET /v1/organizations HTTP/1.1\r\nHost: platform.claude.com\r\nConnection: close\r\n\r\n");
    expect(await reply).toContain("403 Forbidden");
    const [event] = await refusals(runtime, 1);
    expect(event!.payload).toMatchObject({ sessionName: "lab-chat-1", attemptId: "attempt-1", kind: "credential", target: "platform.claude.com:443", code: "OAUTH_ROUTE_DENIED", repeats: 1 });
  });

  it("record bulk work without a grant, for a worker outside the catalogue and under an instrument that is not allowed", async () => {
    const planned = await turn({ mode: "plan" });
    expect((await unix(planned.socket, "/bulk/submit", { configId: "refs", idempotencyKey: "k1", items: [{ id: "a", input: SECRET_PROMPT }] })).body.code).toBe("BULK_EXECUTION_REQUIRED");
    expect((await refusals(planned.runtime, 1))[0]!.payload).toMatchObject({ kind: "grant", target: "local", code: "BULK_EXECUTION_REQUIRED" });

    const { runtime, socket } = await turn();
    expect((await unix(socket, "/bulk/submit", { configId: "elsewhere", idempotencyKey: "k2", items: [{ id: "a", input: "x" }] })).body.code).toBe("WORKER_CONFIG_NOT_FOUND");
    expect((await unix(socket, "/bulk/submit", { configId: "refs", idempotencyKey: "k3", instrumentDigest: "sha256-not-installed", items: [{ id: "a", input: { journal: "J" } }] })).body.code).toBe("INSTRUMENT_NOT_ALLOWED");
    // A request the participant cannot widen by reaching further is no containment record.
    expect((await unix(socket, "/no-such-route")).body.code).toBe("UNKNOWN_WORKER_ROUTE");
    const events = await refusals(runtime, 2);
    await delay(100);
    expect(runtime.store.events(0, 1000).events.filter((event) => event.type === "broker.refusal")).toHaveLength(2);
    expect(events.map((event) => [event.payload.kind, event.payload.target, event.payload.code])).toEqual([
      ["grant", "elsewhere", "WORKER_CONFIG_NOT_FOUND"], ["instrument", "sha256-not-installed", "INSTRUMENT_NOT_ALLOWED"]
    ]);
  });

  it("wake a long poll, are acknowledged like any event and go with the purge of their session", async () => {
    const { runtime, socket } = await turn();
    const head = runtime.store.head();
    const woken = runtime.store.waitForEvents(head, 5_000);
    await raw(socket, "CONNECT example.com:22 HTTP/1.1\r\nHost: example.com:22\r\n\r\n");
    await woken;
    const [first] = await refusals(runtime, 1);
    expect(first!.payload).toMatchObject({ target: "example.com:22", kind: "egress" });
    runtime.store.ack(runtime.store.feedId, first!.seq);
    await raw(socket, "CONNECT 192.168.1.1:443 HTTP/1.1\r\nHost: 192.168.1.1:443\r\n\r\n");
    const [, second] = await refusals(runtime, 2);
    // Purging the session erases its acknowledged refusal at once; the unacknowledged one waits for the feed.
    await runtime.purge("lab-chat-1");
    expect(runtime.store.events(0, 1000).events.filter((event) => event.type === "broker.refusal").map((event) => event.seq)).toEqual([second!.seq]);
    runtime.store.ack(runtime.store.feedId, second!.seq);
    expect(runtime.store.events(0, 1000).events.filter((event) => event.type === "broker.refusal")).toEqual([]);
  });

  it("are written before the store closes, folded counts included", async () => {
    const root = await mkdtemp(join("/tmp", "pcrf-"));
    process.env.TEST_MODEL_KEY = "test-secret";
    const runtime = await AdvancedRuntime.open(root, { defaultLimit: 4 });
    const provider: ModelProviderConfig = { id: "local", model: "judge-model", kind: "codex-openai-compatible", baseUrl: "http://127.0.0.1:9/v1", authTokenEnv: "TEST_MODEL_KEY" };
    const params = startParamsZod.parse({ name: "lab-chat-2", agent: "codex", directory: "/tmp", task: "review", interactionMode: "execute", permissionMode: "approve-all",
      statisticsContext: { version: 1, chatId: "chat-2", attemptId: "attempt-2" }, modelProvider: provider, orchestration: { version: 1, revision: 1, workers: [{ id: "refs", assignment: "x", agent: "codex", modelProvider: provider }] } });
    const session = { ...params, state: "idle", warnings: [], transcript: [], createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() } as unknown as SessionInfo;
    runtime.attach({ start: async () => ({ content: [], details: {} }), quiesce: async () => {}, getSession: () => session, contribution: () => {} });
    await runtime.begin(session, params, "approve-all");
    for (let i = 0; i < 3; i++) await unix(runtime.socket("lab-chat-2")!, "/native/v1/responses", { model: "other-model", input: "x" });
    await runtime.close();
    const reopened = await AdvancedRuntime.open(root, { defaultLimit: 4 });
    cleanups.push(() => reopened.close());
    expect(reopened.store.events(0, 1000).events.filter((event) => event.type === "broker.refusal").map((event) => (event.payload as BrokerRefusalPayload).repeats)).toEqual([1, 2]);
  });
});

describe("broker.refusal events of a run principal", () => {
  async function registry(now: () => number = Date.now) {
    process.env.TEST_MODEL_KEY = "test-secret";
    const dataDir = await mkdtemp(join("/tmp", "pcrp-"));
    const runtime = await AdvancedRuntime.open(join(dataDir, "advanced"), { defaultLimit: 8 });
    runtime.attach({ start: async () => ({ content: [], details: {} }), quiesce: async () => {}, getSession: () => null, contribution: () => {} });
    const judge: ModelProviderConfig = { id: "judge", model: "judge-model", kind: "codex-openai-compatible", baseUrl: "http://127.0.0.1:9/v1", authTokenEnv: "TEST_MODEL_KEY" };
    const other: ModelProviderConfig = { ...judge, id: "other" };
    const principals = await PrincipalRegistry.open({ dataDir, runtime, providers: new Map([["judge", judge], ["other", other]]), legacyAttemptAuthority: false, now });
    cleanups.push(async () => { await principals.shutdown(); await runtime.close(); await principals.close(); });
    return { runtime, principals };
  }
  const body = (grants: Record<string, unknown> = {}) => ({ kind: "run", runId: "study-1", ownerKey: "owner-key-0123456789abcdef", socket: true,
    grants: { providers: ["judge"], instruments: ["sha256-granted"], maxConcurrency: 2, maxItems: null, tokenBudget: null, expiresAt: null, ...grants } });

  it("record a provider and an instrument outside the grants, and work without an instrument", async () => {
    const { runtime, principals } = await registry();
    const socket = (await principals.put("run:study-1", body())).socketPath!;
    expect((await unix(socket, "/bulk/submit", { configId: "other", idempotencyKey: "a", instrumentDigest: "sha256-granted", items: [{ id: "1", input: { journal: "J" } }] })).body.code).toBe("PROVIDER_NOT_GRANTED");
    expect((await unix(socket, "/bulk/submit", { configId: "judge", idempotencyKey: "b", instrumentDigest: "sha256-other", items: [{ id: "1", input: { journal: "J" } }] })).body.code).toBe("INSTRUMENT_NOT_GRANTED");
    expect((await unix(socket, "/bulk/submit", { configId: "judge", idempotencyKey: "c", items: [{ id: "1", input: SECRET_PROMPT }] })).body.code).toBe("INSTRUMENT_REQUIRED");
    expect((await unix(socket, "/agent/submit", { configId: "judge", idempotencyKey: "d", task: SECRET_PROMPT })).body.code).toBe("PRINCIPAL_AGENT_UNSUPPORTED");
    const events = await refusals(runtime, 4);
    expect(events.map((event) => [event.payload.kind, event.payload.target, event.payload.code])).toEqual([
      ["grant", "other", "PROVIDER_NOT_GRANTED"], ["instrument", "sha256-other", "INSTRUMENT_NOT_GRANTED"], ["instrument", "judge", "INSTRUMENT_REQUIRED"], ["grant", "agent", "PRINCIPAL_AGENT_UNSUPPORTED"]
    ]);
    for (const event of events) expect(event.payload).toMatchObject({ sessionName: "principal:run:study-1", attemptId: null, principalId: "run:study-1", jobId: null });
    expect(JSON.stringify(events)).not.toContain(SECRET_PROMPT);
  });

  it("record a chat turn's bulk work while only run principals carry bulk authority", async () => {
    const { runtime } = await registry();
    const provider: ModelProviderConfig = { id: "judge", model: "judge-model", kind: "codex-openai-compatible", baseUrl: "http://127.0.0.1:9/v1", authTokenEnv: "TEST_MODEL_KEY" };
    const params = startParamsZod.parse({ name: "lab-chat-3", agent: "codex", directory: "/tmp", task: "review", interactionMode: "execute", permissionMode: "approve-all",
      statisticsContext: { version: 1, chatId: "chat-3", attemptId: "attempt-3" }, modelProvider: provider, orchestration: { version: 1, revision: 1, workers: [{ id: "refs", assignment: "x", agent: "codex", modelProvider: provider }] } });
    const session = { ...params, state: "idle", warnings: [], transcript: [], createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() } as unknown as SessionInfo;
    await runtime.begin(session, params, "approve-all");
    expect((await unix(runtime.socket("lab-chat-3")!, "/bulk/submit", { configId: "refs", idempotencyKey: "a", items: [{ id: "1", input: SECRET_PROMPT }] })).body.code).toBe("PRINCIPAL_REQUIRED");
    const [event] = await refusals(runtime, 1);
    expect(event!.payload).toMatchObject({ sessionName: "lab-chat-3", attemptId: "attempt-3", principalId: null, kind: "grant", target: "judge", code: "PRINCIPAL_REQUIRED" });
  });

  it("record work under an expired or revoked run credential", async () => {
    let now = Date.now();
    const { runtime, principals } = await registry(() => now);
    const socket = (await principals.put("run:study-1", body({ expiresAt: new Date(now + 60_000).toISOString() }))).socketPath!;
    now += 120_000;
    expect((await unix(socket, "/bulk/submit", { configId: "judge", idempotencyKey: "a", instrumentDigest: "sha256-granted", items: [{ id: "1", input: { journal: "J" } }] })).body.code).toBe("PRINCIPAL_EXPIRED");
    // A request that reaches the socket after the record was revoked (the socket closes right after).
    const entry = (principals as unknown as { entries: Map<string, { record: { revokedAt: string | null } }> }).entries.get("run:study-1")!;
    entry.record = { ...entry.record, revokedAt: new Date(now).toISOString() };
    expect((await unix(socket, "/jobs")).body.code).toBe("PRINCIPAL_REVOKED");
    const events = await refusals(runtime, 2);
    expect(events.map((event) => [event.payload.kind, event.payload.target, event.payload.code])).toEqual([
      ["credential", "run:study-1", "PRINCIPAL_EXPIRED"], ["credential", "run:study-1", "PRINCIPAL_REVOKED"]
    ]);
  });
});
