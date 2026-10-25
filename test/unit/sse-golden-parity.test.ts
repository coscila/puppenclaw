import { describe, expect, it } from "vitest";

import { createDaemonServer } from "../../src/daemon/server.js";
import {
  createTempDir,
  makeConfig,
  normalizeSse,
  resolveFakeAcpxCommand,
  resolveFakeAcpxStreamCommand
} from "../helpers.js";

/**
 * Golden SSE sequences of the session stream routes (plan H4: golden parity
 * tests before keyed turns may stream). Each event is reduced to its kind and
 * visible text; the result event to its output.
 */

type Scenario = {
  label: string;
  runner: "bash" | "stream";
  task: string;
  golden: string[];
};

const SCENARIOS: Scenario[] = [
  {
    label: "plain reply",
    runner: "bash",
    task: "golden reply",
    golden: [
      'chunk:""',
      'chunk:"Handled: golden reply"',
      'final:"Handled: golden reply"',
      'complete:"Turn completed."',
      'result:"Handled: golden reply"',
      "done"
    ]
  },
  {
    label: "input request",
    runner: "bash",
    task: "ASK_USER which source",
    golden: [
      'chunk:""',
      "activity:tool_call:Localized input title",
      'chunk:"Need input from the user?"',
      'final:"Need input from the user?"',
      'question:"Which source should I use?"',
      'complete:"Turn completed and is waiting for user input."',
      'result:"Need input from the user?"',
      "done"
    ]
  },
  {
    label: "plan",
    runner: "bash",
    task: "EXIT_PLAN_MODE plan it",
    golden: [
      'chunk:""',
      "activity:status:Agent plan updated.",
      "activity:tool_call:Localized plan title",
      'chunk:"The plan is ready. Should I proceed?"',
      'final:"The plan is ready. Should I proceed?"',
      'complete:"Turn completed."',
      'result:"The plan is ready. Should I proceed?"',
      "done"
    ]
  },
  {
    label: "failed turn",
    runner: "bash",
    task: "FAIL_TURN now",
    golden: ['chunk:""', "error:SIM_FAIL", 'result:"Simulated turn failure"', "done"]
  },
  {
    label: "streamed chunks with activity",
    runner: "stream",
    task: "STREAM_CHUNKS=3 STREAM_INTERVAL_MS=5 STREAM_CHUNK_CHARS=10 STREAM_ACTIVITY_EVERY=2 FINAL_NEWLINE",
    golden: [
      'chunk:""',
      "activity:tool_call:step 1",
      'chunk:"<0>.......<1>.......<2>.......\\n"',
      'final:"<0>.......<1>.......<2>......."',
      'complete:"Turn completed."',
      'result:"<0>.......<1>.......<2>......."',
      "done"
    ]
  }
];

async function daemon(runner: Scenario["runner"]) {
  const dataDir = await createTempDir("puppenclaw-sse-golden-");
  const workspace = await createTempDir("puppenclaw-sse-golden-ws-");
  const acpxCommand = runner === "bash" ? await resolveFakeAcpxCommand() : resolveFakeAcpxStreamCommand();
  const { app } = await createDaemonServer({
    config: makeConfig({ acpxCommand }),
    dataDir,
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  });
  return { app, workspace };
}

describe("golden SSE sequences", () => {
  for (const scenario of SCENARIOS) {
    it(`unkeyed start: ${scenario.label}`, async () => {
      const { app, workspace } = await daemon(scenario.runner);
      try {
        const response = await app.inject({
          method: "POST",
          url: "/session/start/stream",
          payload: { agent: "claude", name: "golden-unkeyed", directory: workspace, task: scenario.task }
        });
        expect(response.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
        expect(normalizeSse(response.body)).toEqual(scenario.golden);
      } finally {
        await app.close();
      }
    });
  }

  it("unkeyed send follows the same sequence as start", async () => {
    const { app, workspace } = await daemon("bash");
    try {
      await app.inject({
        method: "POST",
        url: "/session/start",
        payload: { agent: "claude", name: "golden-send", directory: workspace, task: "prime" }
      });
      const response = await app.inject({
        method: "POST",
        url: "/session/golden-send/send/stream",
        payload: { message: "golden reply" }
      });
      expect(normalizeSse(response.body)).toEqual(SCENARIOS[0]!.golden);
    } finally {
      await app.close();
    }
  });

  it("a keyed turn without the keyedStreaming opt-in keeps today's result-only stream", async () => {
    const { app, workspace } = await daemon("stream");
    try {
      const response = await app.inject({
        method: "POST",
        url: "/session/start/stream",
        payload: {
          agent: "claude",
          name: "golden-keyed-legacy",
          directory: workspace,
          task: SCENARIOS[4]!.task,
          turnKey: "golden:legacy:1"
        }
      });
      expect(normalizeSse(response.body)).toEqual(['result:"<0>.......<1>.......<2>......."', "done"]);
    } finally {
      await app.close();
    }
  });

  // Keyed streaming is not implemented yet: these parity cases are expected to fail
  // until the keyedStreaming opt-in exists, and are flipped to plain tests with it.
  for (const scenario of SCENARIOS) {
    it.fails(`keyed start with keyedStreaming matches the unkeyed golden: ${scenario.label}`, async () => {
      const { app, workspace } = await daemon(scenario.runner);
      try {
        const response = await app.inject({
          method: "POST",
          url: "/session/start/stream",
          payload: {
            agent: "claude",
            name: "golden-keyed",
            directory: workspace,
            task: scenario.task,
            turnKey: `golden:${scenario.runner}:1`,
            keyedStreaming: true
          }
        });
        expect(normalizeSse(response.body)).toEqual(scenario.golden);
      } finally {
        await app.close();
      }
    });
  }
});
