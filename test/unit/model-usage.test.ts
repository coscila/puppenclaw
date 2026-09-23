import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { AcpxSessionManager } from "../../src/manager/acpx.js";
import {
  MAX_MODEL_USAGE_THREADS,
  parseOcslModelUsage,
  type ModelUsageGroup
} from "../../src/shared/model-usage.js";
import type { ModelProviderConfig } from "../../src/shared/types.js";
import { UsageLedgerStore } from "../../src/shared/usage-ledger.js";
import { TurnStatisticsRecorder } from "../../src/statistics/recorder.js";
import { TurnStatisticsStore } from "../../src/statistics/store.js";
import { createStoreAndRouter, createTempDir, makeConfig } from "../helpers.js";

type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};

function usage(input: number, cached: number, output: number, reasoning = 0, cacheWrite = 0): Usage {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output
  };
}

function thread(threadId: string, model: string, value: Usage, parentThreadId: string | null = "main") {
  return {
    threadId,
    parentThreadId,
    role: parentThreadId == null ? "main" : "subagent",
    agentRole: parentThreadId == null ? null : "worker",
    model,
    usage: value
  };
}

function line(threads: unknown[]) {
  return { type: "ocsl.model_usage", version: 1, threads };
}

const MAIN = thread("main", "gpt-6-luna", usage(1000, 600, 50, 10, 100), null);
const WORKER_1 = thread("worker-1", "chat", usage(40000, 30000, 2000, 1500));
const WORKER_2 = thread("worker-2", "chat", usage(60000, 50000, 3000, 2500));

describe("ocsl.model_usage parsing", () => {
  it("groups threads by (role, model) with main first and sums raw usage", () => {
    const other = thread("reviewer", "chat-large", usage(10, 0, 1), "worker-1");
    expect(parseOcslModelUsage(line([WORKER_1, other, MAIN, WORKER_2]))).toEqual<ModelUsageGroup[]>([
      { role: "main", model: "gpt-6-luna", threads: 1, usage: usage(1000, 600, 50, 10, 100) },
      { role: "subagent", model: "chat", threads: 2, usage: usage(100000, 80000, 5000, 4000) },
      { role: "subagent", model: "chat-large", threads: 1, usage: usage(10, 0, 1) }
    ]);
  });

  it("defaults a missing cache write field and drops zero-usage threads", () => {
    const { cache_write_input_tokens: _omitted, ...withoutCacheWrite } = usage(5, 1, 2);
    expect(parseOcslModelUsage(line([
      { ...MAIN, usage: withoutCacheWrite },
      thread("idle", "chat", usage(0, 0, 0))
    ]))).toEqual([{ role: "main", model: "gpt-6-luna", threads: 1, usage: usage(5, 1, 2) }]);
    expect(parseOcslModelUsage(line([thread("idle", "chat", usage(0, 0, 0))]))).toBeNull();
  });

  it.each([
    ["a different type", { ...line([MAIN]), type: "ocsl.other" }],
    ["another version", { ...line([MAIN]), version: 2 }],
    ["no threads", line([])],
    ["threads that are not an array", { ...line([]), threads: {} }],
    ["too many threads", line(Array.from({ length: MAX_MODEL_USAGE_THREADS + 1 }, (_, index) => thread(`t${index}`, "chat", usage(1, 0, 1))))],
    ["a negative count", line([{ ...MAIN, usage: { ...MAIN.usage, output_tokens: -1 } }])],
    ["a fractional count", line([{ ...MAIN, usage: { ...MAIN.usage, input_tokens: 1.5 } }])],
    ["a string count", line([{ ...MAIN, usage: { ...MAIN.usage, input_tokens: "1000" } }])],
    ["an unsafe count", line([{ ...MAIN, usage: { ...MAIN.usage, input_tokens: 2 ** 60 } }])],
    ["a missing usage field", line([{ ...MAIN, usage: { input_tokens: 1, output_tokens: 1 } }])],
    ["a main thread with a parent", line([{ ...MAIN, parentThreadId: "x" }])],
    ["a subagent without a parent", line([{ ...WORKER_1, parentThreadId: null }])],
    ["an unknown role", line([{ ...WORKER_1, role: "helper" }])],
    ["an empty model", line([{ ...MAIN, model: "" }])],
    ["duplicate thread ids", line([MAIN, { ...WORKER_1, threadId: "main" }])],
    ["an overflowing group sum", line([
      thread("a", "chat", usage(Number.MAX_SAFE_INTEGER - 1, 0, 0)),
      thread("b", "chat", usage(Number.MAX_SAFE_INTEGER - 1, 0, 0))
    ])],
    ["a non-object", "ocsl.model_usage"]
  ])("rejects %s", (_label, raw) => {
    expect(parseOcslModelUsage(raw)).toBeNull();
  });
});

describe("statistics recorder per-model usage", () => {
  async function recorderFor(name: string) {
    const store = await TurnStatisticsStore.open(await createTempDir("statistics-models-"));
    const recorder = new TurnStatisticsRecorder(store, { listComputeJobs: () => [] });
    recorder.admit(
      { version: 1, chatId: "chat", attemptId: name },
      { name, agent: "codex", model: "gpt-6-luna", modelProviderId: "remote_langdock_gpt6_luna_xhigh" },
      name
    );
    return { store, recorder };
  }
  const groups = parseOcslModelUsage(line([MAIN, WORKER_1, WORKER_2]))!;
  const summed = {
    input: 101000, output: 5050, cacheRead: 80600, cacheWrite: 100, reasoning: 4010, total: 106050
  };

  it("keeps today's row without a line (no models field)", async () => {
    const { store, recorder } = await recorderFor("plain");
    recorder.observeEvent("plain", { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } }, "codex");
    await recorder.settle("plain", "completed");
    const row = store.page().turns[0]!;
    expect("models" in row).toBe(false);
    expect(row.tokens).toEqual({ input: 1000, output: 50, cacheRead: 600, cacheWrite: 0, reasoning: null, total: 1050, quality: "measured" });
    await recorder.close();
  });

  it("records models with summed turn tokens and never adds turn.completed usage", async () => {
    const { store, recorder } = await recorderFor("models");
    recorder.observeEvent("models", { type: "token_count", info: { total_token_usage: { input_tokens: 5, output_tokens: 5 } } }, "codex");
    recorder.observeEvent("models", { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } }, "codex");
    recorder.observeModelUsage("models", groups, { localWorkers: true });
    // A late native event cannot replace or add to the wrapper totals.
    recorder.observeEvent("models", { type: "turn.completed", usage: { input_tokens: 7, output_tokens: 7 } }, "codex");
    await recorder.settle("models", "completed");
    const row = store.page().turns[0]!;
    expect(row.tokens).toEqual({ ...summed, quality: "measured" });
    expect(row.coverageReasons).toEqual([]);
    expect(row.models).toEqual([
      {
        role: "main", model: "gpt-6-luna", modelProviderId: "remote_langdock_gpt6_luna_xhigh", threads: 1,
        tokens: { input: 1000, output: 50, cacheRead: 600, cacheWrite: 100, reasoning: 10, total: 1050, quality: "measured" }
      },
      {
        role: "subagent", model: "chat", modelProviderId: null, threads: 2,
        tokens: { input: 100000, output: 5000, cacheRead: 80000, cacheWrite: 0, reasoning: 4000, total: 105000, quality: "measured" }
      }
    ]);
    await recorder.close();
  });

  it("keeps subagents on the session provider without a local worker policy", async () => {
    const { store, recorder } = await recorderFor("plain-subagents");
    const own = parseOcslModelUsage(line([MAIN, thread("helper", "gpt-6-luna", usage(700, 100, 70))]))!;
    recorder.observeModelUsage("plain-subagents", own);
    await recorder.settle("plain-subagents", "completed");
    const row = store.page().turns[0]!;
    expect(row.models?.map((model) => [model.role, model.model, model.modelProviderId, model.tokens.total])).toEqual([
      ["main", "gpt-6-luna", "remote_langdock_gpt6_luna_xhigh", 1050],
      ["subagent", "gpt-6-luna", "remote_langdock_gpt6_luna_xhigh", 770]
    ]);
    expect(row.tokens.total).toBe(1820);
    await recorder.close();
  });

  it("lets the last line win and marks non-completed model usage partial", async () => {
    const { store, recorder } = await recorderFor("last");
    recorder.observeModelUsage("last", parseOcslModelUsage(line([thread("main", "gpt-6-luna", usage(9, 0, 9), null)]))!);
    recorder.observeModelUsage("last", groups);
    await recorder.settle("last", "failed");
    const row = store.page().turns[0]!;
    expect(row.tokens).toEqual({ ...summed, quality: "partial" });
    expect(row.models?.map((model) => [model.model, model.tokens.total, model.tokens.quality])).toEqual([
      ["gpt-6-luna", 1050, "partial"],
      ["chat", 105000, "partial"]
    ]);
    await recorder.close();
  });

  it("downgrades persisted model usage of interrupted turns on recovery", async () => {
    const root = await createTempDir("statistics-models-recover-");
    const store = await TurnStatisticsStore.open(root);
    const recorder = new TurnStatisticsRecorder(store, { listComputeJobs: () => [] });
    recorder.admit({ version: 1, chatId: "chat", attemptId: "crash" }, { name: "crash", agent: "codex" }, "crash");
    recorder.observeModelUsage("crash", groups);
    await recorder.beginSegment({ name: "crash", agent: "codex" } as never); // checkpoints the running row
    store.recoverInterrupted();
    const row = store.page().turns.at(-1)!;
    expect(row.state).toBe("interrupted");
    expect(row.tokens.quality).toBe("partial");
    expect(row.models?.every((model) => model.tokens.quality === "partial")).toBe(true);
    store.close();
  });
});

const GPT6_PROVIDER: ModelProviderConfig = {
  id: "remote_langdock_gpt6_luna_xhigh", kind: "codex-openai-compatible", model: "gpt-6-luna"
};
// "Use local model workers": every subagent is pinned to the Local LLM.
const LOCAL_WORKER_PROVIDER: ModelProviderConfig = {
  ...GPT6_PROVIDER, subagents: { model: "chat", effort: "xhigh", maxConcurrentThreads: 6 }
};

async function runnerSetup() {
  const root = await createTempDir("codex-model-usage-");
  const { store, outputRouter } = await createStoreAndRouter(root);
  const statisticsStore = await TurnStatisticsStore.open(join(root, "statistics"));
  const statistics = new TurnStatisticsRecorder(statisticsStore, { listComputeJobs: () => [] });
  const ledger = await UsageLedgerStore.open(join(root, "usage"));
  const chunks: string[] = [];
  const activities: unknown[] = [];
  vi.spyOn(outputRouter, "onChunk").mockImplementation(async (_name, text) => { chunks.push(text); });
  vi.spyOn(outputRouter, "onActivity").mockImplementation(async (_name, activity) => { activities.push(activity); });
  const manager = new AcpxSessionManager({
    config: makeConfig({ agentCommands: { codex: `node "${fileURLToPath(new URL("../fixtures/fake-codex-model-usage.mjs", import.meta.url))}"` } }),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    store, outputRouter, statistics, ledger
  });
  const start = (scenario: string, name = "lab", modelProvider: ModelProviderConfig = LOCAL_WORKER_PROVIDER) => manager.start({
    agent: "codex", name, directory: root,
    task: `SCENARIO:${scenario}`, contextFiles: [],
    modelProvider,
    statisticsContext: { version: 1, chatId: "chat", attemptId: `${name}-${scenario}` }
  });
  const diagnostics = async (): Promise<Array<{ eventCounts: Record<string, number> }>> => {
    const snapshots = [];
    for (const session of await readdir(join(root, "diagnostics")).catch(() => [] as string[])) {
      for (const file of await readdir(join(root, "diagnostics", session))) {
        snapshots.push(JSON.parse(await readFile(join(root, "diagnostics", session, file), "utf8")));
      }
    }
    return snapshots;
  };
  return { root, manager, store, statisticsStore, statistics, ledger, chunks, activities, start, diagnostics };
}

const MAIN_LEDGER_USAGE = { input: 300, output: 50, cacheRead: 600, cacheWrite: 100, total: 1050 };
const SUB_LEDGER_USAGE = { input: 20000, output: 5000, cacheRead: 80000, cacheWrite: 0, total: 105000 };

describe("Codex one-shot turns with the ocsl.model_usage line", () => {
  it.each(["line", "trailing", "invalid-after-valid"])(
    "records per-model statistics and ledger rows without transcript pollution (%s)",
    async (scenario) => {
      const setup = await runnerSetup();
      try {
        const result = await setup.start(scenario);
        expect(result.details).toMatchObject({ output: "Model usage final answer.", session: { state: "idle" } });
        expect(setup.store.getSession("lab")?.transcript.map((entry) => [entry.role, entry.text])).toEqual([
          ["user", `SCENARIO:${scenario}`],
          ["assistant", "Model usage final answer."]
        ]);
        const published = JSON.stringify([setup.chunks, setup.activities, result]);
        expect(published).not.toMatch(/ocsl|model_usage|worker-1/u);
        expect(setup.activities).toEqual([
          { type: "tool_call", title: "spawn_agent" },
          { type: "tool_output", title: "spawn_agent" }
        ]);

        const row = setup.statisticsStore.page().turns[0]!;
        expect(row.tokens).toEqual({
          input: 101000, output: 5050, cacheRead: 80600, cacheWrite: 100, reasoning: 4010, total: 106050, quality: "measured"
        });
        expect(row.models?.map((model) => [model.role, model.model, model.modelProviderId, model.threads, model.tokens.total])).toEqual([
          ["main", "gpt-6-luna", "remote_langdock_gpt6_luna_xhigh", 1, 1050],
          ["subagent", "chat", null, 2, 105000]
        ]);

        const history = setup.ledger.perSessionHistory("lab");
        const turnId = row.runnerTurnId;
        expect(history.map(({ timestamp: _t, durationMs: _d, id: _id, ...rest }) => rest).sort((a, b) => a.model.localeCompare(b.model))).toEqual([
          { sessionName: "lab", agent: "codex", provider: "remote_langdock_gpt6_luna_xhigh", model: "chat",
            usage: SUB_LEDGER_USAGE, turnId, role: "subagent", threads: 2, localWorkers: true },
          { sessionName: "lab", agent: "codex", provider: "remote_langdock_gpt6_luna_xhigh", model: "gpt-6-luna",
            usage: MAIN_LEDGER_USAGE, turnId, role: "main", threads: 1 }
        ]);
        expect(new Set(history.map((entry) => entry.id)).size).toBe(2);
        expect(history.every((entry) => entry.id.startsWith(`usage-${turnId}-`))).toBe(true);
        expect(setup.ledger.perSessionTotals("lab")).toEqual({
          turns: 1,
          usage: { input: 20300, output: 5050, cacheRead: 80600, cacheWrite: 100, total: 106050 }
        });
        const [snapshot] = await setup.diagnostics();
        expect(snapshot?.eventCounts).toEqual({
          "thread.started": 1, "turn.started": 1, "item.started": 1, "item.completed": 2, "turn.completed": 1,
          // A truncated line is not JSON, so it stays a malformed protocol record.
          ...(scenario === "invalid-after-valid" ? { malformed_json: 1 } : {})
        });
      } finally {
        await setup.statistics.close();
        setup.ledger.close();
      }
    }
  );

  it.each([
    ["a GPT-6 chat without local workers", GPT6_PROVIDER],
    ["a Local LLM medium chat", { id: "remote_qwen38_medium", kind: "codex-openai-compatible", model: "chat" } as const]
  ])("keeps subagents on the session provider in %s", async (_label, provider: ModelProviderConfig) => {
    const setup = await runnerSetup();
    try {
      await setup.start("line", "plain", provider);
      const row = setup.statisticsStore.page().turns[0]!;
      expect(row.tokens.total).toBe(106050);
      expect(row.models?.map((model) => [model.role, model.model, model.modelProviderId, model.threads])).toEqual([
        ["main", "gpt-6-luna", provider.id, 1],
        ["subagent", "chat", provider.id, 2]
      ]);
      const history = setup.ledger.perSessionHistory("plain")
        .map((entry) => [entry.role, entry.provider, entry.model, entry.localWorkers])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      expect(history).toEqual([
        ["main", provider.id, provider.model, undefined],
        ["subagent", provider.id, "chat", false]
      ]);
    } finally {
      await setup.statistics.close();
      setup.ledger.close();
    }
  });

  it("uses the last valid line", async () => {
    const setup = await runnerSetup();
    try {
      await setup.start("last-wins");
      const row = setup.statisticsStore.page().turns[0]!;
      expect(row.tokens.total).toBe(2 * 106050);
      expect(row.models?.map((model) => model.tokens.total)).toEqual([2 * 1050, 2 * 105000]);
      expect(setup.ledger.perSessionTotals("lab")).toMatchObject({ turns: 1, usage: { total: 2 * 106050 } });
    } finally {
      await setup.statistics.close();
      setup.ledger.close();
    }
  });

  it.each(["none", "invalid"])("keeps today's main-thread accounting when no valid line arrives (%s)", async (scenario) => {
    const setup = await runnerSetup();
    try {
      const result = await setup.start(scenario);
      expect(result.details).toMatchObject({ output: "Model usage final answer.", session: { state: "idle" } });
      expect(JSON.stringify([setup.chunks, setup.activities, setup.store.getSession("lab")?.transcript])).not.toMatch(/ocsl|must not leak/u);
      const row = setup.statisticsStore.page().turns[0]!;
      expect("models" in row).toBe(false);
      expect(row.tokens).toEqual({ input: 1000, output: 50, cacheRead: 600, cacheWrite: 0, reasoning: null, total: 1050, quality: "measured" });
      const history = setup.ledger.perSessionHistory("lab");
      expect(history).toHaveLength(1);
      expect(Object.keys(history[0]!).sort()).toEqual(["agent", "durationMs", "id", "model", "provider", "sessionName", "timestamp", "usage"]);
      expect(history[0]).toMatchObject({ model: "gpt-6-luna", usage: { input: 400, output: 50, cacheRead: 600, cacheWrite: 0, total: 1050 } });
      const [snapshot] = await setup.diagnostics();
      expect(snapshot?.eventCounts.other).toBeUndefined();
    } finally {
      await setup.statistics.close();
      setup.ledger.close();
    }
  });

  it("keeps the failed-turn ledger skip while statistics carry the line", async () => {
    const setup = await runnerSetup();
    try {
      const result = await setup.start("failed");
      expect(result.details).toMatchObject({ session: { state: "failed", failureCode: "CODEX_TURN_FAILED" } });
      const row = setup.statisticsStore.page().turns[0]!;
      expect(row.state).toBe("failed");
      expect(row.tokens).toMatchObject({ total: 106050, quality: "partial" });
      expect(row.models).toHaveLength(2);
      expect(setup.ledger.perSessionHistory("lab")).toEqual([]);
    } finally {
      await setup.statistics.close();
      setup.ledger.close();
    }
  });

  it("counts distinct turns in cost totals while history keeps one row per model", async () => {
    const setup = await runnerSetup();
    try {
      await setup.start("line");
      await setup.manager.send({
        name: "lab", message: "SCENARIO:line", contextFiles: [],
        statisticsContext: { version: 1, chatId: "chat", attemptId: "second" }
      });
      const cost = await setup.manager.cost({ name: "lab" });
      const details = cost.details as { turns: number; history: Array<{ turnId: string }>; totals: { usage: { total: number } } };
      expect(details.turns).toBe(2);
      expect(details.history).toHaveLength(4);
      expect(new Set(details.history.map((entry) => entry.turnId)).size).toBe(2);
      expect(details.totals.usage.total).toBe(2 * 106050);
      expect(cost.content[0]).toMatchObject({ text: expect.stringContaining("2 turns") });
      const rollup = (await setup.manager.cost({})).details as { rollup: Array<{ model: string; turns: number }> };
      expect(rollup.rollup.map((entry) => [entry.model, entry.turns])).toEqual([["chat", 2], ["gpt-6-luna", 2]]);
    } finally {
      await setup.statistics.close();
      setup.ledger.close();
    }
  });
});
