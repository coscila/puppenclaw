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
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

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

/** One advanced Claude controller turn whose client calls the provider only through the broker's native route. */
async function controllerTurn(baseUrl: string, task: string): Promise<Record<string, any>> {
  const root = await createTempDir("advanced-native-limit-");
  const { store, outputRouter } = await createStoreAndRouter(join(root, "sessions"));
  const statistics = new TurnStatisticsRecorder(await TurnStatisticsStore.open(join(root, "statistics")), { listComputeJobs: () => [] });
  const advanced = await AdvancedRuntime.open(join(root, "advanced"));
  const command = fileURLToPath(new URL("../fixtures/fake-native-client-acpx.mjs", import.meta.url));
  const manager = new AcpxSessionManager({ config: makeConfig({ acpxCommand: `node ${command}` }), logger: { info() {}, warn() {}, error() {}, debug() {} }, store, outputRouter, advanced, statistics });
  advanced.attach({ start: (params) => manager.start(params), quiesce: async (name) => { await manager.quiesce({ name }); }, getSession: (name) => store.getSession(name), contribution: (receipt) => statistics.observeBrokerReceipt(receipt.parentSessionName, receipt) });
  cleanups.push(async () => { await advanced.close(); await statistics.close(); await store.close(); });
  const provider = { id: "synthetic-claude", kind: "claude-code", model: "synthetic-model", baseUrl };
  const params = startParamsZod.parse({ name: "controller", agent: "claude", directory: root, task, permissionMode: "approve-all", interactionMode: "execute", modelProvider: provider, modelProviderId: provider.id, statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt" }, turnKey: "approved-turn", orchestration: { version: 1, revision: 1, workers: [{ id: "refs", assignment: "Review sources", agent: "claude", modelProvider: provider }] } });
  return (await manager.start(params)).details as Record<string, any>;
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
    const details = await controllerTurn(provider.url, task);
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
    const details = await controllerTurn(provider.url, "Review");
    expect(provider.calls()).toBe(2);
    expect(details).toMatchObject({ output: "Reviewed.", session: { state: "idle" } });
    expect(details.failureCode).toBeUndefined();
  }, 20_000);
  it("leaves an unrelated failure untyped once a later call has succeeded", async () => {
    const provider = await upstream([[429, "1"], [200]]);
    const details = await controllerTurn(provider.url, "Review FAIL_AFTER_REPLY");
    expect(provider.calls()).toBe(2);
    expect(details).toMatchObject({ session: { state: "failed" } });
    expect(details.failureCode).toBeUndefined();
    expect(details.resumeAfter).toBeUndefined();
  }, 20_000);
});
