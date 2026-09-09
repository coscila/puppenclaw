import { describe, expect, it } from "vitest";
import { TurnStatisticsStore } from "../../src/statistics/store.js";
import { TurnStatisticsRecorder } from "../../src/statistics/recorder.js";
import {
  createTempDir,
  makeConfig,
  resolveFakeAcpxCommand,
} from "../helpers.js";
import { createDaemonServer } from "../../src/daemon/server.js";
import {
  fingerprintStartRequest,
  fingerprintSendRequest,
} from "../../src/shared/turn-idempotency.js";
import type { SessionInfo, StartParams } from "../../src/shared/types.js";
import type { ProcSnapshot } from "../../src/resources/proc.js";

describe("conversation statistics recording", () => {
  it("settles from monotonic execution time, preserves partial failure usage and never counts idle time", async () => {
    const store = await TurnStatisticsStore.open(
      await createTempDir("statistics-recorder-"),
    );
    let clock = 1000;
    const snapshot = (): ProcSnapshot => ({
      sampledAtMs: clock,
      uptimeSeconds: 10,
      processes: new Map(),
      hostCpu: null,
      memInfo: null,
      loadAvg: null,
    });
    const recorder = new TurnStatisticsRecorder(store, {
      listComputeJobs: () => [],
      now: () => clock,
      readSnapshot: async () => snapshot(),
    });
    const session = {
      name: "main",
      agent: "claude",
      model: "claude-fable-5-1",
    } as SessionInfo;
    recorder.admit(
      { version: 1, chatId: "chat", attemptId: "attempt" },
      session,
      "turn",
    );
    clock = 6000;
    await recorder.beginSegment(session); // preflight/queue time excluded
    recorder.observeEvent(
      "main",
      {
        result: {
          stopReason: "end_turn",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedReadTokens: 20,
            cachedWriteTokens: 0,
          },
        },
      },
      "acp",
    );
    clock = 9000;
    await recorder.settle("main", "failed");
    clock = 99000;
    await recorder.sample();
    expect(store.page().turns[0]).toMatchObject({
      state: "failed",
      activeElapsedMs: 3000,
      tokens: { input: 30, total: 35, quality: "partial" },
      cpu: { agentCpuMs: null, quality: "unavailable" },
    });
    expect(() =>
      recorder.admit(
        { version: 1, chatId: "chat", attemptId: "attempt" },
        session,
        "turn",
      ),
    ).toThrow(/already has/);
    await recorder.close();
  });
  it("does not infer Codex turn usage from session-cumulative counters or hide workflow gaps", async () => {
    const store = await TurnStatisticsStore.open(
      await createTempDir("statistics-usage-"),
    );
    const recorder = new TurnStatisticsRecorder(store, {
      listComputeJobs: () => [],
    });
    const session = { name: "main", agent: "codex" };
    recorder.admit(
      { version: 1, chatId: "chat", attemptId: "attempt" },
      session,
      "turn",
    );
    recorder.observeEvent(
      "main",
      {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 10000, output_tokens: 2000 },
        },
      },
      "codex",
    );
    await recorder.settle("main", "cancelled");
    expect(store.page().turns[0]).toMatchObject({
      state: "cancelled",
      tokens: { total: null, quality: "unavailable" },
      coverageReasons: ["cumulative_usage_without_baseline"],
    });
    recorder.admit(
      { version: 1, chatId: "chat", attemptId: "next" },
      { name: "claude", agent: "claude" },
      "next",
    );
    recorder.observeEvent(
      "claude",
      {
        params: {
          update: { toolCallId: "ocsl-workflow:own", status: "in_progress" },
        },
      },
      "acp",
    );
    recorder.observeEvent(
      "claude",
      {
        result: {
          stopReason: "end_turn",
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            cachedReadTokens: 0,
            cachedWriteTokens: 0,
          },
        },
      },
      "acp",
    );
    await recorder.settle("claude", "completed");
    expect(store.page().turns.at(-1)).toMatchObject({
      tokens: { total: 3, quality: "partial" },
      coverageReasons: ["workflow_usage_coverage_unverified"],
    });
    await recorder.close();
  });
  it("binds statistics attribution into new fingerprints without changing legacy request digests", () => {
    const base: StartParams = {
      agent: "claude",
      name: "main",
      directory: "/tmp",
      task: "test",
      contextFiles: [],
    };
    const context = {
      version: 1 as const,
      chatId: "chat",
      attemptId: "attempt",
    };
    expect(
      fingerprintStartRequest({ ...base, statisticsContext: context }),
    ).not.toBe(fingerprintStartRequest(base));
    expect(
      fingerprintSendRequest({
        name: "main",
        message: "test",
        contextFiles: [],
        statisticsContext: context,
      }),
    ).not.toBe(
      fingerprintSendRequest({
        name: "main",
        message: "test",
        contextFiles: [],
      }),
    );
    expect(
      fingerprintStartRequest({
        ...base,
        statisticsContext: { ...context, attemptId: "other" },
      }),
    ).not.toBe(
      fingerprintStartRequest({ ...base, statisticsContext: context }),
    );
  });
  it("deduplicates native result increments, ignores repeated final aggregates, and retains cancelled usage", async () => {
    const store = await TurnStatisticsStore.open(
      await createTempDir("statistics-bridge-"),
    );
    const recorder = new TurnStatisticsRecorder(store, {
      listComputeJobs: () => [],
    });
    recorder.admit(
      { version: 1, chatId: "chat", attemptId: "attempt" },
      { name: "main", agent: "claude" },
      "turn",
    );
    const emit = (eventId: string, scope: string) =>
      recorder.observeEvent(
        "main",
        {
          params: {
            update: {
              sessionUpdate: "usage_update",
              _meta: {
                ocslUsage: {
                  version: 1,
                  eventId,
                  scope,
                  usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    cache_read_input_tokens: 20,
                    cache_creation_input_tokens: 0,
                  },
                },
              },
            },
          },
        },
        "acp",
      );
    emit("user-1", "user");
    emit("user-1", "user");
    emit("child-1", "owned-autonomous");
    emit("old-child", "unattributed");
    recorder.observeEvent(
      "main",
      {
        result: {
          stopReason: "cancelled",
          usage: {
            inputTokens: 9999,
            outputTokens: 9999,
            cachedReadTokens: 0,
            cachedWriteTokens: 0,
          },
        },
      },
      "acp",
    );
    await Promise.all([
      recorder.settle("main", "cancelled"),
      recorder.settle("main", "completed"),
    ]);
    expect(store.page().turns[0]).toMatchObject({
      state: "cancelled",
      tokens: { input: 60, output: 10, total: 70, quality: "partial" },
      coverageReasons: ["unattributed_autonomous_usage"],
    });
    await recorder.close();
  });
  it("baselines reused runtime roots across idle periods and deduplicates concurrent process ownership", async () => {
    const store = await TurnStatisticsStore.open(
      await createTempDir("statistics-cpu-"),
    );
    let clock = 0,
      cpuTicks = 100;
    const recorder = new TurnStatisticsRecorder(store, {
      listComputeJobs: () => [],
      now: () => clock,
      readSnapshot: async () => ({
        sampledAtMs: clock,
        uptimeSeconds: 100,
        hostCpu: null,
        memInfo: null,
        loadAvg: null,
        processes: new Map([
          [
            42,
            {
              pid: 42,
              ppid: 1,
              name: "verified",
              startTicks: "50",
              cpuTicks,
              rssBytes: 0,
            },
          ],
        ]),
      }),
    });
    const first = { name: "first", agent: "claude" } as SessionInfo;
    const second = { name: "second", agent: "claude" } as SessionInfo;
    recorder.admit(
      { version: 1, chatId: "chat", attemptId: "first" },
      first,
      "first",
    );
    recorder.registerRoot("first", { pid: 42, startTicks: "50" });
    await recorder.beginSegment(first);
    recorder.admit(
      { version: 1, chatId: "other", attemptId: "second" },
      second,
      "second",
    );
    recorder.registerRoot("second", { pid: 42, startTicks: "50" });
    await recorder.beginSegment(second);
    cpuTicks = 120;
    clock = 1000;
    await recorder.sample();
    await recorder.settle("second", "completed");
    await recorder.settle("first", "completed");
    expect(
      store.page().turns.find((r) => r.attemptId === "first")?.cpu.agentCpuMs,
    ).toBe(200);
    expect(
      store.page().turns.find((r) => r.attemptId === "second")?.cpu,
    ).toMatchObject({
      agentCpuMs: null,
      coverageReasons: [
        "process_sampling",
        "shared_process_ownership_conflict",
      ],
    });
    cpuTicks = 1000;
    clock = 60000; // idle work is not this next conversation turn
    recorder.admit(
      { version: 1, chatId: "chat", attemptId: "third" },
      first,
      "third",
    );
    await recorder.beginSegment(first);
    cpuTicks = 1010;
    clock = 61000;
    await recorder.settle("first", "completed");
    expect(store.page().turns.at(-1)).toMatchObject({
      activeElapsedMs: 1000,
      cpu: { agentCpuMs: 100, quality: "partial" },
    });
    await recorder.close();
  });
  it("serves authenticated update cursors and deduplicates keyed replays while excluding automation", async () => {
    const root = await createTempDir("statistics-daemon-");
    const { app } = await createDaemonServer({
      dataDir: root,
      config: makeConfig({
        acpxCommand: await resolveFakeAcpxCommand(),
        daemonAuthToken: "synthetic-statistics-auth",
      }),
    });
    const headers = { authorization: "Bearer synthetic-statistics-auth" };
    try {
      expect(
        (await app.inject({ method: "GET", url: "/statistics/turns" }))
          .statusCode,
      ).toBe(401);
      const payload = {
        agent: "claude",
        name: "main",
        directory: root,
        task: "Complete the synthetic task",
        contextFiles: [],
        turnKey: "same-turn",
        statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt" },
      };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/session/start",
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(200);
      const page = JSON.parse(
        (await app.inject({ method: "GET", url: "/statistics/turns", headers }))
          .body,
      ).details;
      expect(page.turns).toHaveLength(1);
      expect(page.turns[0]).toMatchObject({
        state: "completed",
        chatId: "chat",
        attemptId: "attempt",
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/session/start",
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/statistics/turns?cursor=${page.nextCursor}`,
              headers,
            })
          ).body,
        ).details.turns,
      ).toEqual([]);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/session/main/send",
            headers,
            payload: { message: "Background metadata", contextFiles: [] },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/statistics/turns?cursor=${page.nextCursor}`,
              headers,
            })
          ).body,
        ).details.turns,
      ).toEqual([]);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/statistics/turns?cursor=wrong",
            headers,
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
});
