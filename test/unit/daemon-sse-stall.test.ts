import { request, type IncomingMessage } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDaemonServer } from "../../src/daemon/server.js";
import { createTempDir, makeConfig, resolveFakeAcpxStreamCommand } from "../helpers.js";

const CAP = 256 * 1024;
const FLOOD = 6_000_000;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function readEvents(response: IncomingMessage): Promise<Array<Record<string, unknown>>> {
  response.setEncoding("utf8");
  let body = "";
  response.on("data", (chunk: string) => {
    body += chunk;
  });
  response.resume();
  await new Promise((resolve) => response.once("end", resolve));
  return body
    .split("\n\n")
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => line != null)
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

describe("daemon SSE with a stalled consumer", () => {
  it("keeps draining the runner, bounds the stream backlog and delivers gap and terminal events", async () => {
    vi.stubEnv("PUPPENCLAW_SSE_MAX_PENDING_BYTES", String(CAP));
    const dataDir = await createTempDir("puppenclaw-sse-stall-");
    const workspace = await createTempDir("puppenclaw-sse-stall-ws-");
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: resolveFakeAcpxStreamCommand() }),
      dataDir,
      logger: { info() {}, warn() {}, error() {}, debug() {} }
    });
    const url = new URL(await app.listen({ host: "127.0.0.1", port: 0 }));
    try {
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = request(
          { host: url.hostname, port: url.port, path: "/session/start/stream", method: "POST", headers: { "content-type": "application/json" } },
          resolve
        );
        req.once("error", reject);
        req.end(
          JSON.stringify({
            agent: "claude",
            name: "lab-stall",
            directory: workspace,
            task: `FLOOD_BYTES=${FLOOD} FLOOD_CHUNK_CHARS=8192 FLOOD_LINE_CHARS=512`,
            resultView: "turn"
          })
        );
      });
      // The consumer stops reading at once and stays stalled until the turn is over.
      response.pause();

      const runningBacklog: number[] = [];
      let completed = false;
      for (let attempt = 0; attempt < 600 && !completed; attempt += 1) {
        const [status, health] = await Promise.all([
          app.inject({ method: "GET", url: "/session/lab-stall?view=summary" }),
          app.inject({ method: "GET", url: "/v2/health" })
        ]);
        const details = status.statusCode === 200
          ? (JSON.parse(status.body) as {
              details: { session: { activeTurn?: { state: string } }; turn?: { outputChars: number } };
            }).details
          : undefined;
        const turn = details?.session.activeTurn;
        completed = turn?.state === "completed";
        // While the runner is still producing, only live deltas are queued; the
        // never-dropped final and result events follow once its output is complete.
        if (turn?.state === "running" && (details?.turn?.outputChars ?? 0) < FLOOD) {
          runningBacklog.push((JSON.parse(health.body) as { backlog: { streamBytes: number } }).backlog.streamBytes);
        }
        if (!completed) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      // The runner's output was consumed in full while nobody read the stream.
      expect(completed).toBe(true);
      expect(runningBacklog.length).toBeGreaterThan(0);
      expect(Math.max(...runningBacklog)).toBeLessThanOrEqual(CAP);

      const events = await readEvents(response);
      const kinds = events.map((event) => event.kind);
      expect(kinds.slice(-4)).toEqual(["final", "complete", "result", "done"]);
      const gaps = events.filter((event) => event.kind === "gap");
      expect(gaps.length).toBeGreaterThanOrEqual(1);
      expect(gaps.every((gap) => Number(gap.droppedEvents) > 0 && Number(gap.droppedBytes) > 0)).toBe(true);
      expect(kinds.indexOf("gap")).toBeLessThan(kinds.indexOf("final"));
      const result = events.at(-2) as { result: { details: { output: string; view: string } } };
      expect(result.result.details.view).toBe("turn");
      expect(result.result.details.output.length).toBeGreaterThanOrEqual(FLOOD - 1);
      const streamed = events
        .filter((event) => event.kind === "chunk")
        .reduce((sum, event) => sum + String(event.text).length, 0);
      expect(streamed).toBeLessThan(FLOOD);
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  }, 120_000);
});
