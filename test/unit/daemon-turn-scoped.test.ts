import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDaemonServer } from "../../src/daemon/server.js";
import {
  createTempDir,
  makeConfig,
  resolveFakeAcpxCommand,
  seedSession,
  seedTranscript,
  writeSeedState
} from "../helpers.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

type Result = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown> & {
    session: Record<string, unknown>;
    contextFiles?: Array<Record<string, unknown>>;
    turnReceipt?: { turnKey: string; state: string };
  };
  protocol?: unknown;
  bootId?: string;
  spoolId?: string;
};

function sseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

describe("turn-scoped start and send results", () => {
  it("returns the turn and a session snapshot without the transcript when the request opts in", async () => {
    const dataDir = await createTempDir("puppenclaw-turn-scoped-");
    const workspace = await createTempDir("puppenclaw-turn-scoped-ws-");
    await writeFile(join(workspace, "notes.md"), "context for the turn\n", "utf8");
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      dataDir,
      logger: quiet
    });
    try {
      const legacy = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: "/session/start",
            payload: { agent: "claude", name: "lab-legacy", directory: workspace, task: "first", contextFiles: ["notes.md"] }
          })
        ).body
      ) as Result;
      expect(Array.isArray(legacy.details.session.transcript)).toBe(true);
      expect(legacy.details.contextFiles?.[0]).toHaveProperty("resolvedPath");
      expect(legacy).not.toHaveProperty("bootId");

      const response = await app.inject({
        method: "POST",
        url: "/session/start",
        payload: {
          agent: "claude",
          name: "lab-turn",
          directory: workspace,
          task: "first",
          contextFiles: ["notes.md"],
          resultView: "turn"
        }
      });
      expect(response.statusCode).toBe(200);
      const scoped = JSON.parse(response.body) as Result;
      expect(scoped.protocol).toEqual({ major: 2, minor: 0 });
      expect(scoped.bootId).toBe(response.headers["x-puppenclaw-boot-id"]);
      expect(scoped.details).toMatchObject({
        view: "turn",
        output: expect.stringContaining("Handled: first") as string,
        outputRole: "assistant",
        contextFiles: [{ path: "notes.md", bytes: 21, truncated: false }]
      });
      expect(scoped.details.session).not.toHaveProperty("transcript");
      expect(scoped.details.session).not.toHaveProperty("directory");
      expect(scoped.details.session).toMatchObject({
        name: "lab-turn",
        state: "idle",
        activeTurn: { state: "completed" }
      });
    } finally {
      await app.close();
    }
  });

  it("keeps the opt-in out of the keyed fingerprint and gives keyed and unkeyed turns one shape", async () => {
    const dataDir = await createTempDir("puppenclaw-turn-scoped-keyed-");
    const workspace = await createTempDir("puppenclaw-turn-scoped-keyed-ws-");
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      dataDir,
      logger: quiet
    });
    const request = { agent: "claude", name: "lab-keyed", directory: workspace, task: "keyed task", turnKey: "attempt-1" };
    try {
      const accepted = JSON.parse(
        (await app.inject({ method: "POST", url: "/session/start", payload: { ...request, resultView: "turn" } })).body
      ) as Result;
      expect(accepted.details.turnReceipt).toEqual({ turnKey: "attempt-1", state: "accepted" });
      expect(accepted.details.session).not.toHaveProperty("transcript");
      expect(accepted.details.view).toBe("turn");

      // Same key without the opt-in: a replay, not a conflict, in the legacy shape.
      const replay = await app.inject({ method: "POST", url: "/session/start", payload: request });
      expect(replay.statusCode).toBe(200);
      const replayBody = JSON.parse(replay.body) as Result;
      expect(replayBody.details.turnReceipt).toEqual({ turnKey: "attempt-1", state: "replayed" });
      expect(replayBody).not.toHaveProperty("bootId");
      expect(replayBody.details).not.toHaveProperty("view");

      const unkeyed = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: "/session/lab-keyed/send",
            payload: { message: "unkeyed follow-up", resultView: "turn" }
          })
        ).body
      ) as Result;
      expect(Object.keys(unkeyed.details.session).sort()).toEqual(Object.keys(accepted.details.session).sort());
    } finally {
      await app.close();
    }
  });

  it("stays small for a long conversation and applies to the streamed result event", async () => {
    const dataDir = await createTempDir("puppenclaw-turn-scoped-long-");
    const workspace = await createTempDir("puppenclaw-turn-scoped-long-ws-");
    await writeSeedState(dataDir, [seedSession("lab-long", workspace, { transcript: seedTranscript(400, 5_000) })]);
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      dataDir,
      logger: quiet
    });
    try {
      const scoped = await app.inject({
        method: "POST",
        url: "/session/lab-long/send",
        payload: { message: "next question", resultView: "turn" }
      });
      expect(scoped.statusCode).toBe(200);
      expect(Buffer.byteLength(scoped.body)).toBeLessThan(10_000);
      expect((JSON.parse(scoped.body) as Result).details.session).toMatchObject({ name: "lab-long", state: "idle" });

      const legacy = await app.inject({ method: "POST", url: "/session/lab-long/send", payload: { message: "again" } });
      expect(Buffer.byteLength(legacy.body)).toBeGreaterThan(2_000_000);

      const stream = await app.inject({
        method: "POST",
        url: "/session/lab-long/send/stream",
        payload: { message: "streamed", resultView: "turn" }
      });
      const result = sseEvents(stream.body).find((event) => event.kind === "result") as { result: Result } | undefined;
      expect(result?.result.details.view).toBe("turn");
      expect(result?.result.details.session).not.toHaveProperty("transcript");
      expect(result?.result.bootId).toBe(stream.headers["x-puppenclaw-boot-id"]);
      expect(Buffer.byteLength(stream.body)).toBeLessThan(10_000);

      const invalid = await app.inject({
        method: "POST",
        url: "/session/lab-long/send",
        payload: { message: "x", resultView: "full" }
      });
      expect(invalid.statusCode).toBe(400);
      expect(JSON.parse(invalid.body)).toMatchObject({ code: "INVALID_PARAMS" });
    } finally {
      await app.close();
    }
  });
});
