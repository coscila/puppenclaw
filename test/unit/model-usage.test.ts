import { describe, expect, it } from "vitest";

import {
  MAX_MODEL_USAGE_THREADS,
  parseOcslModelUsage,
  type ModelUsageGroup
} from "../../src/shared/model-usage.js";
import { TurnStatisticsRecorder } from "../../src/statistics/recorder.js";
import { TurnStatisticsStore } from "../../src/statistics/store.js";
import { createTempDir } from "../helpers.js";

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
    recorder.observeModelUsage("models", groups);
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
