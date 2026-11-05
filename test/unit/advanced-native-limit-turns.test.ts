import { createServer, type RequestListener } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AdvancedRuntime } from "../../src/advanced/runtime.js";
import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { startParamsZod } from "../../src/shared/schema.js";
import { TurnStatisticsRecorder } from "../../src/statistics/recorder.js";
import { TurnStatisticsStore } from "../../src/statistics/store.js";
import { createStoreAndRouter, createTempDir, makeConfig } from "../helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); delete process.env.TEST_MODEL_KEY; });

/** A fake provider on an ephemeral port; answers holds the status and Retry-After of each call in turn (the last repeats). */
async function upstream(answers: [number, string?][]): Promise<{ url: string; calls: () => number }> {
  let calls = 0;
  const handler: RequestListener = (req, res) => {
    req.resume();
    const [status, retryAfter] = answers[Math.min(calls++, answers.length - 1)]!;
    res.writeHead(status, { "content-type": "application/json", ...(retryAfter ? { "retry-after": retryAfter } : {}) });
    res.end(status === 200 ? '{"model":"synthetic-model","usage":{"input_tokens":10,"output_tokens":2}}' : '{"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}');
  };
  const server = createServer(handler); await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, calls: () => calls };
}

/**
 * One advanced controller turn, keyed, whose client calls the provider only through the broker's native route: Claude
 * through acpx, or Codex as a one-shot runtime. replay repeats the request under its turn key.
 */
async function controllerTurn(baseUrl: string, task: string, agent: "claude" | "codex" = "claude"): Promise<{ details: Record<string, any>; replay: () => Promise<Record<string, any>> }> {
  const root = await createTempDir("advanced-native-limit-");
  const { store, outputRouter } = await createStoreAndRouter(join(root, "sessions"));
  const statistics = new TurnStatisticsRecorder(await TurnStatisticsStore.open(join(root, "statistics")), { listComputeJobs: () => [] });
  const advanced = await AdvancedRuntime.open(join(root, "advanced"));
  const fixture = (name: string) => `node ${fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))}`;
  const config = agent === "claude" ? makeConfig({ acpxCommand: fixture("fake-native-client-acpx.mjs") }) : makeConfig({ agentCommands: { codex: fixture("fake-native-codex.mjs") } });
  const manager = new AcpxSessionManager({ config, logger: { info() {}, warn() {}, error() {}, debug() {} }, store, outputRouter, advanced, statistics });
  advanced.attach({ start: (params) => manager.start(params), quiesce: async (name) => { await manager.quiesce({ name }); }, getSession: (name) => store.getSession(name), contribution: (receipt) => statistics.observeBrokerReceipt(receipt.parentSessionName, receipt) });
  cleanups.push(async () => { await advanced.close(); await statistics.close(); await store.close(); });
  if (agent === "codex") process.env.TEST_MODEL_KEY = "test-secret";
  const provider = agent === "claude"
    ? { id: "synthetic-claude", kind: "claude-code", model: "synthetic-model", baseUrl }
    : { id: "synthetic-codex", kind: "codex-openai-compatible", model: "synthetic-model", baseUrl, authTokenEnv: "TEST_MODEL_KEY" };
  const params = startParamsZod.parse({ name: "controller", agent, directory: root, task, permissionMode: "approve-all", interactionMode: "execute", modelProvider: provider, modelProviderId: provider.id, statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt" }, turnKey: "approved-turn", contextFiles: [], orchestration: { version: 1, revision: 1, workers: [{ id: "refs", assignment: "Review sources", agent, modelProvider: provider }] } });
  const details = (await manager.start(params)).details as Record<string, any>;
  return { details, replay: async () => (await manager.start(params)).details as Record<string, any> };
}

describe("advanced controller turns that end on a provider limit", () => {
  it.each([
    ["a 429 that outlasts the client's retries", "Review", [[429, "1"]], 3, 1_000],
    ["a 503 without a reset that outlasts the client's retries", "Review", [[503]], 3, undefined],
    ["a 429 whose reset lies beyond the 60 s the client waits", "Review", [[429, "3600"]], 1, 3_600_000],
    ["a broker pause that the client's next call meets", "Review RETRY_ANY", [[429, "3600"]], 1, 3_600_000]
  ] as const)("ends %s PROVIDER_PAUSED and retryable, with the provider's reset", async (_label, task, answers, calls, resetMs) => {
    const provider = await upstream(answers.map((answer) => [...answer]));
    const before = Date.now();
    const { details } = await controllerTurn(provider.url, task);
    expect(provider.calls()).toBe(calls);
    expect(details).toMatchObject({ failureCode: "PROVIDER_PAUSED", retryable: true, outputRole: "status", session: { state: "failed", failureCode: "PROVIDER_PAUSED", retryable: true } });
    if (resetMs === undefined) expect(details.resumeAfter).toBeUndefined();
    else {
      expect(Date.parse(details.resumeAfter)).toBeGreaterThanOrEqual(before + resetMs);
      expect(Date.parse(details.resumeAfter)).toBeLessThanOrEqual(Date.now() + resetMs);
    }
  }, 20_000);
  it("completes the turn when the client's retry after a passed-through 429 succeeds", async () => {
    const provider = await upstream([[429, "1"], [200]]);
    const { details } = await controllerTurn(provider.url, "Review");
    expect(provider.calls()).toBe(2);
    expect(details).toMatchObject({ output: "Reviewed.", session: { state: "idle" } });
    expect(details.failureCode).toBeUndefined();
  }, 20_000);
  it("leaves an unrelated failure untyped once a later call has succeeded", async () => {
    const provider = await upstream([[429, "1"], [200]]);
    const { details } = await controllerTurn(provider.url, "Review FAIL_AFTER_REPLY");
    expect(provider.calls()).toBe(2);
    expect(details).toMatchObject({ session: { state: "failed" } });
    expect(details.failureCode).toBeUndefined();
    expect(details.resumeAfter).toBeUndefined();
  }, 20_000);
  it("answers a keyed replay of such a turn with the same failure, without the reset", async () => {
    const provider = await upstream([[429, "3600"]]);
    const { details, replay } = await controllerTurn(provider.url, "Review");
    expect(details).toMatchObject({ failureCode: "PROVIDER_PAUSED", resumeAfter: expect.any(String), turnReceipt: { state: "accepted" } });
    const replayed = await replay();
    expect(replayed).toMatchObject({ failureCode: "PROVIDER_PAUSED", retryable: true, turnReceipt: { state: "replayed" } });
    expect(replayed.resumeAfter).toBeUndefined();
    expect(provider.calls()).toBe(1);
  }, 20_000);
  it("ends a Codex controller turn whose client gave up on a passed-through 429 PROVIDER_PAUSED", async () => {
    const provider = await upstream([[429, "1"]]);
    const before = Date.now();
    const { details } = await controllerTurn(provider.url, "Review", "codex");
    expect(provider.calls()).toBe(3);
    expect(details).toMatchObject({ failureCode: "PROVIDER_PAUSED", retryable: true, session: { state: "failed", failureCode: "PROVIDER_PAUSED" } });
    expect(Date.parse(details.resumeAfter)).toBeGreaterThanOrEqual(before + 1_000);
  }, 20_000);
});
