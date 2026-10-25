import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SSE_MAX_PENDING_BYTES,
  MAX_COALESCED_CHUNK_CHARS,
  SseEventStream,
  sseMaxPendingBytesFromEnv
} from "../../src/daemon/sse.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

/** Stall length of the memory-bound test; the plan asks for 30 s. */
const STALL_MS = Number(process.env.PUPPENCLAW_SSE_STALL_TEST_MS ?? 30_000);

type Harness = {
  server: Server;
  stream: SseEventStream;
  response: IncomingMessage;
  raw: ServerResponse;
};

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function harness(maxPendingBytes: number, pauseClient: boolean): Promise<Harness> {
  let resolveStream!: (value: { stream: SseEventStream; raw: ServerResponse }) => void;
  const ready = new Promise<{ stream: SseEventStream; raw: ServerResponse }>((resolve) => {
    resolveStream = resolve;
  });
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.flushHeaders();
    resolveStream({ stream: new SseEventStream(res, { sessionName: "sse-test", maxPendingBytes }), raw: res });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: address.port, path: "/", method: "GET" }, resolve);
    req.once("error", reject);
    req.end();
  });
  if (pauseClient) {
    response.pause();
  }
  const { stream, raw } = await ready;
  return { server, stream, response, raw };
}

async function readAll(response: IncomingMessage): Promise<Array<Record<string, unknown>>> {
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SSE stream backpressure", () => {
  it("defaults the pending cap to 8 MiB with an environment override and a floor", () => {
    expect(DEFAULT_SSE_MAX_PENDING_BYTES).toBe(8 * 1024 * 1024);
    expect(sseMaxPendingBytesFromEnv({})).toBe(8 * 1024 * 1024);
    expect(sseMaxPendingBytesFromEnv({ PUPPENCLAW_SSE_MAX_PENDING_BYTES: "1048576" })).toBe(1_048_576);
    expect(sseMaxPendingBytesFromEnv({ PUPPENCLAW_SSE_MAX_PENDING_BYTES: "10" })).toBe(64 * 1024);
  });

  it("writes every frame straight through to a reading client, unchanged and in order", async () => {
    const { stream, response } = await harness(DEFAULT_SSE_MAX_PENDING_BYTES, false);
    const received = readAll(response);
    for (let index = 0; index < 200; index += 1) {
      stream.send({ kind: "chunk", sessionName: "sse-test", text: `piece-${index};` });
    }
    stream.send({ kind: "done" });
    stream.end();
    const events = await received;
    expect(events).toHaveLength(201);
    expect(events.slice(0, 200).map((event) => event.text)).toEqual(
      Array.from({ length: 200 }, (_, index) => `piece-${index};`)
    );
    expect(stream.stats).toMatchObject({ coalescedEvents: 0, droppedEvents: 0, gaps: 0 });
  });

  it(
    `bounds memory while a consumer stalls for ${STALL_MS / 1000} s, then delivers a gap and every terminal event`,
    async () => {
      const { stream, response, raw } = await harness(DEFAULT_SSE_MAX_PENDING_BYTES, true);
      gc();
      const baselineHeap = process.memoryUsage().heapUsed;
      const baselineRss = process.memoryUsage().rss;
      let pushedChunks = 0;
      let pushedChars = 0;
      let maxPending = 0;
      let maxHeapGrowth = 0;
      let maxRssGrowth = 0;
      const piece = "x".repeat(10_240);
      const startedAt = Date.now();
      let sample = 0;
      // About 4 MB/s of live output for the whole stall: far more than the cap.
      while (Date.now() - startedAt < STALL_MS) {
        for (let burst = 0; burst < 20; burst += 1) {
          // Distinct flat strings, as real deltas are: shared strings would hide the queue's size.
          const text = Buffer.alloc(piece.length, 97 + (pushedChunks % 26)).toString("latin1");
          stream.send({ kind: "chunk", sessionName: "sse-test", text });
          pushedChunks += 1;
          pushedChars += text.length;
        }
        if (pushedChunks % 500 === 0) {
          stream.send({ kind: "activity", sessionName: "sse-test", activity: { type: "status", text: "tick" } });
        }
        maxPending = Math.max(maxPending, stream.pendingBytes);
        sample += 1;
        if (sample % 100 === 0) {
          gc();
          maxHeapGrowth = Math.max(maxHeapGrowth, process.memoryUsage().heapUsed - baselineHeap);
          maxRssGrowth = Math.max(maxRssGrowth, process.memoryUsage().rss - baselineRss);
        }
        await sleep(50);
      }
      expect(maxPending).toBeLessThanOrEqual(DEFAULT_SSE_MAX_PENDING_BYTES);
      expect(stream.stats.droppedEvents).toBeGreaterThan(0);
      // The queue is the only growth: at most the 8 MiB cap plus bookkeeping.
      expect(maxHeapGrowth).toBeLessThan(10 * 1024 * 1024);
      console.info(
        `SSE stall ${STALL_MS} ms: pushed ${(pushedChars / 1048576).toFixed(1)} MiB in ${pushedChunks} chunks, ` +
          `max pending ${(maxPending / 1048576).toFixed(2)} MiB, max heap growth ${(maxHeapGrowth / 1048576).toFixed(2)} MiB, ` +
          `max RSS growth ${(maxRssGrowth / 1048576).toFixed(2)} MiB, dropped ${stream.stats.droppedEvents} events`
      );

      const result = { kind: "result", result: { content: [], details: { output: "r".repeat(1_048_576) } } };
      stream.send({ kind: "final", sessionName: "sse-test", text: "final answer" });
      stream.send(result);
      stream.send({ kind: "done" });
      stream.end();
      expect(raw.writableEnded).toBe(true);

      const events = await readAll(response);
      const kinds = events.map((event) => event.kind);
      expect(kinds.slice(-3)).toEqual(["final", "result", "done"]);
      const gaps = events.filter((event) => event.kind === "gap");
      expect(gaps.length).toBeGreaterThanOrEqual(1);
      expect(gaps.reduce((sum, gap) => sum + Number(gap.droppedEvents), 0)).toBe(stream.stats.droppedEvents);
      expect(kinds.indexOf("gap")).toBeLessThan(kinds.indexOf("final"));
      const deliveredChars = events
        .filter((event) => event.kind === "chunk")
        .reduce((sum, event) => sum + String(event.text).length, 0);
      expect(deliveredChars).toBeLessThan(pushedChars);
      expect(String((events.at(-2)?.result as { details: { output: string } }).details.output)).toHaveLength(1_048_576);
      for (const event of events.filter((candidate) => candidate.kind === "chunk")) {
        expect(String(event.text).length).toBeLessThanOrEqual(MAX_COALESCED_CHUNK_CHARS);
      }
    },
    STALL_MS + 60_000
  );

  it("coalesces queued chunks, keeps terminal events above the cap and frees the queue on disconnect", async () => {
    const small = 64 * 1024;
    const { stream, response } = await harness(small, true);
    for (let index = 0; index < 2_000; index += 1) {
      stream.send({ kind: "chunk", sessionName: "sse-test", text: "y".repeat(1_000) });
    }
    expect(stream.pendingBytes).toBeLessThanOrEqual(small);
    expect(stream.stats.coalescedEvents).toBeGreaterThan(0);
    expect(stream.stats.droppedEvents).toBeGreaterThan(0);
    stream.send({ kind: "error", sessionName: "sse-test", text: "x".repeat(200_000), code: "SIM_FAIL" });
    expect(stream.pendingBytes).toBeGreaterThan(small);
    response.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stream.isClosed).toBe(true);
    expect(stream.pendingBytes).toBe(0);
    stream.send({ kind: "done" });
    expect(stream.pendingEvents).toBe(0);
  });
});
