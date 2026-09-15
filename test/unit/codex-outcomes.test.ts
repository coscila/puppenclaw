import { describe, expect, it } from "vitest";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { TurnStatisticsRecorder } from "../../src/statistics/recorder.js";
import { TurnStatisticsStore } from "../../src/statistics/store.js";
import type { SessionInfo } from "../../src/shared/types.js";
import { createStoreAndRouter, createTempDir, makeConfig } from "../helpers.js";

async function setup(scenario: string) {
  const root = await createTempDir("codex-outcome-");
  const { store, outputRouter } = await createStoreAndRouter(root);
  const statisticsStore = await TurnStatisticsStore.open(join(root, "statistics"));
  const statistics = new TurnStatisticsRecorder(statisticsStore, { listComputeJobs: () => [] });
  const manager = new AcpxSessionManager({
    config: makeConfig({ agentCommands: { codex: `node "${fileURLToPath(new URL("../fixtures/fake-codex-outcome.mjs", import.meta.url))}"` } }),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    store, outputRouter, statistics
  });
  const run = () => manager.start({
    agent: "codex", name: "outcome", directory: root,
    task: `SCENARIO:${scenario}`, contextFiles: [],
    modelProvider: { id: "local-test", kind: "codex-openai-compatible", model: "chat" },
    statisticsContext: { version: 1, chatId: "chat", attemptId: scenario }
  });
  return { root, manager, store, statisticsStore, run };
}

describe("Codex native outcomes through the runner", () => {
  it.each(["commentary", "error"])("fails %s-only output without promoting it to a final answer", async (scenario) => {
    const { run, store, statisticsStore } = await setup(scenario);
    const result = await run();
    expect(result.details).toMatchObject({ outputRole: "status", session: { state: "failed", failureCode: "NO_FINAL_MESSAGE", activeTurn: { state: "failed", exitCode: 0, signal: null } } });
    expect(store.getSession("outcome")?.transcript.filter((entry) => entry.role === "assistant")).toEqual([]);
    expect(statisticsStore.page().turns[0]).toMatchObject({ state: "failed", tokens: { input: 100, output: 20 } });
  });

  it("honors native turn.failed even with exit zero and a final file", async () => {
    const { run, statisticsStore } = await setup("failed");
    const result = await run();
    expect(result.details).toMatchObject({ outputRole: "status", session: { state: "failed", activeTurn: { state: "failed", exitCode: 0 } } });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(JSON.stringify(result)).not.toContain("Incomplete file answer.");
    expect(statisticsStore.page().turns[0]?.state).toBe("failed");
  });

  it("rejects a JSON final candidate without terminal completion", async () => {
    const { run, store, statisticsStore } = await setup("json-no-terminal");
    const result = await run();
    expect(result.details).toMatchObject({ outputRole: "status", session: { state: "failed", failureCode: "NO_FINAL_MESSAGE" } });
    expect(store.getSession("outcome")?.transcript.filter((entry) => entry.role === "assistant")).toEqual([]);
    expect(statisticsStore.page().turns[0]?.state).toBe("failed");
  });

  it.each(["file", "transient", "json-final"])("completes %s with genuine final-answer provenance", async (scenario) => {
    const { run, store, statisticsStore } = await setup(scenario);
    const result = await run();
    const expected = scenario === "json-final" ? "Explicit JSON final." : "Authoritative file answer.";
    expect(result.details).toMatchObject({ output: expected, outputRole: "assistant", session: { state: "idle", activeTurn: { state: "completed" } } });
    expect(store.getSession("outcome")?.transcript.filter((entry) => entry.role === "assistant").map((entry) => entry.text)).toEqual([expected]);
    expect(statisticsStore.page().turns[0]?.state).toBe("completed");
  });

  it.skipIf(process.platform === "win32").each(["sigterm", "sigkill"])("fails unexpected %s rather than reporting exit zero", async (scenario) => {
    const { run, statisticsStore } = await setup(scenario);
    const result = await run();
    expect(result.details).toMatchObject({ outputRole: "status", session: { state: "failed", activeTurn: { state: "failed", exitCode: null, signal: scenario.toUpperCase() } } });
    expect(statisticsStore.page().turns[0]?.state).toBe("failed");
  });

  it("keeps explicit user stop distinct from an unexpected signal", async () => {
    const { root, manager, run, statisticsStore } = await setup("stop");
    const running = run();
    await expect.poll(() => access(join(root, "ready")).then(() => true, () => false)).toBe(true);
    await manager.stop({ name: "outcome" });
    const result = await running;
    expect((result.details as { session: SessionInfo }).session.activeTurn?.state).toBe("stopped");
    expect(statisticsStore.page().turns[0]?.state).toBe("cancelled");
  });
});
