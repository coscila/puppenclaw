import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AdvancedRuntime } from "../../src/advanced/runtime.js";
import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { TurnStatisticsRecorder } from "../../src/statistics/recorder.js";
import { TurnStatisticsStore } from "../../src/statistics/store.js";
import { startParamsZod } from "../../src/shared/schema.js";
import type { OutputRouteEvent } from "../../src/shared/output-router.js";
import { createStoreAndRouter, createTempDir, makeConfig } from "../helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise((done) => setTimeout(done, 10)); }
  throw new Error("Synthetic lifecycle did not reach expected state");
}
async function setup() {
  const root = await createTempDir("advanced-manager-join-");
  const { store, outputRouter } = await createStoreAndRouter(join(root, "sessions"));
  const statistics = new TurnStatisticsRecorder(await TurnStatisticsStore.open(join(root, "statistics")), { listComputeJobs: () => [] });
  const advanced = await AdvancedRuntime.open(join(root, "advanced"));
  const command = fileURLToPath(new URL("../fixtures/fake-orchestrated-acpx.mjs", import.meta.url));
  const manager = new AcpxSessionManager({ config: makeConfig({ acpxCommand: `node ${command}` }), logger: { info() {}, warn() {}, error() {}, debug() {} }, store, outputRouter, advanced, statistics });
  advanced.attach({ start: (params) => manager.start(params), quiesce: async (name) => { await manager.quiesce({ name }); }, getSession: (name) => store.getSession(name), contribution: (receipt) => statistics.observeBrokerReceipt(receipt.parentSessionName, receipt) });
  cleanups.push(async () => { await advanced.close(); await statistics.close(); await store.close(); });
  const events: OutputRouteEvent[] = [];
  outputRouter.attach("parent", (event) => { events.push(event); });
  const provider = { id: "synthetic-claude", kind: "claude-code", model: "synthetic-model" };
  const params = startParamsZod.parse({ name: "parent", agent: "claude", directory: root, task: "Review and integrate evidence", permissionMode: "approve-all", interactionMode: "execute", modelProvider: provider, modelProviderId: provider.id, statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt" }, turnKey: "approved-turn", orchestration: { version: 1, revision: 1, workers: [{ id: "refs", assignment: "Review sources", agent: "claude", modelProvider: provider }] } });
  return { root, manager, advanced, statistics, store, events, params };
}

describe("advanced parent turn lifecycle", () => {
  it.each([["start", "execute"], ["send", "execute"], ["start", "plan"]] as const)("keeps a completed native %s %s prompt running until workers settle, then continues once before final publication", async (operation, mode) => {
    const { root, manager, advanced, statistics, store, events, params: initialParams } = await setup();
    const params = { ...initialParams, interactionMode: mode, permissionMode: mode === "plan" ? "approve-reads" as const : "approve-all" as const };
    if (operation === "send") {
      await manager.start({ name: params.name, agent: params.agent, directory: root, task: "Seed existing session", modelProvider: params.modelProvider, contextFiles: [] });
      events.length = 0;
    }
    const dispatch = () => operation === "start" ? manager.start(params) : manager.send({ name: params.name, message: params.task, permissionMode: params.permissionMode, interactionMode: params.interactionMode, statisticsContext: params.statisticsContext, orchestration: params.orchestration, turnKey: params.turnKey, contextFiles: [] });
    const running = dispatch();
    await waitFor(() => events.some((event) => event.kind === "activity" && event.activity.title === "Waiting for workers"));
    const jobId = await readFile(join(root, "parent-submitted"), "utf8");
    expect(advanced.store.job(jobId)?.state).toBe("running");
    expect(events.filter((event) => ["final", "complete"].includes(event.kind))).toEqual([]);
    expect(statistics.store.page().turns[0]?.state).toBe("running");
    const inspection = await manager.status({ name: "parent" });
    expect(inspection.details).toMatchObject({ session: { state: "running" }, turn: { classification: "running", lockHeld: true, trackedChild: false } });
    expect(store.getTurnRequest("parent", "approved-turn")?.state).toBe("running");
    await writeFile(join(root, "release-worker"), "go");
    const result = await running;
    expect(result.details).toMatchObject({ output: "Integrated verified worker findings.", session: { state: "idle" } });
    expect(advanced.store.job(jobId)).toMatchObject({ state: "completed", attemptId: "attempt" });
    expect(await readFile(join(root, "worker-permission"), "utf8")).toBe(params.permissionMode);
    expect(await readFile(join(root, "parent-continuation-permission"), "utf8")).toBe(params.permissionMode);
    expect(events.filter((event) => event.kind === "final")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "complete")).toHaveLength(1);
    expect(statistics.store.page().turns).toHaveLength(1);
    expect(statistics.store.page().turns[0]).toMatchObject({ attemptId: "attempt", state: "completed" });
    expect(store.getSession("parent")?.transcript.filter((entry) => entry.role === "assistant").map((entry) => entry.text).slice(-2)).toEqual(["Workers are running; I am waiting for their findings.", "Integrated verified worker findings."]);
    // Retrying the same request replays its durable outcome, never the work.
    expect((await dispatch()).details).toMatchObject({ output: "Integrated verified worker findings." });
    expect(advanced.store.jobs("parent")).toHaveLength(1);
  }, 20000);
  it.each(["stop", "quiesce"] as const)("cascades an explicit %s during the join and never invokes a continuation", async (operation) => {
    const { root, manager, advanced, events, params } = await setup();
    const running = manager.start(params).catch((error: unknown) => error);
    await waitFor(() => events.some((event) => event.kind === "activity" && event.activity.title === "Waiting for workers"));
    await manager[operation]({ name: "parent" });
    await running;
    expect(advanced.store.jobs("parent")[0]?.state).toBe("cancelled");
    expect(existsSync(join(root, "parent-continuation"))).toBe(false);
    expect(events.filter((event) => event.kind === "complete")).toEqual([]);
  }, 20000);
  it("preserves an explicit plan approval boundary and cancels remaining workers", async () => {
    const { root, manager, advanced, params } = await setup();
    await writeFile(join(root, "approval-boundary"), "plan");
    const result = await manager.start(params);
    expect(result.details).toMatchObject({ turnSignals: { plan: { source: "claude-tool" } } });
    expect(advanced.store.jobs("parent")[0]?.state).toBe("cancelled");
    expect(existsSync(join(root, "parent-continuation"))).toBe(false);
  }, 20000);
  it("integrates paused worker status and waits for the user without resubmitting it", async () => {
    const { root, manager, advanced, events, params } = await setup();
    await writeFile(join(root, "pause-worker"), "pause");
    const running = manager.start(params);
    await waitFor(() => events.some((event) => event.kind === "activity" && event.activity.title === "Waiting for workers"));
    await writeFile(join(root, "release-worker"), "go");
    const result = await running;
    expect(result.details).toMatchObject({ session: { state: "waiting_input" }, output: "The worker needs restored access." });
    expect(advanced.store.jobs("parent")).toHaveLength(1);
    expect(advanced.store.jobs("parent")[0]?.state).toBe("paused");
    expect(events.filter((event) => event.kind === "complete")).toHaveLength(1);
  }, 20000);
  it("keeps an already observed paused worker waiting for user input without an extra model turn", async () => {
    const { root, manager, advanced, events, params } = await setup();
    for (const flag of ["pause-worker", "observe-worker", "release-worker"]) await writeFile(join(root, flag), "go");
    const result = await manager.start(params);
    expect(result.details).toMatchObject({ session: { state: "waiting_input" } });
    expect(advanced.store.jobs("parent")[0]?.state).toBe("paused");
    expect(existsSync(join(root, "parent-continuation"))).toBe(false);
    expect(events.filter((event) => event.kind === "complete")).toHaveLength(1);
  }, 20000);
});
