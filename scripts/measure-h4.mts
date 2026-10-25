/**
 * Plan H4 acceptance measurements against a real daemon process.
 *
 *   npm run build && node --experimental-strip-types scripts/measure-h4.mts [--window-ms N] [--stall-ms N]
 *
 * Starts dist/daemon/cli.js on a free loopback port with a throwaway data
 * directory, a production-sized session store (about 9 MB of transcripts in 165
 * sessions) and the streaming fake runner, then reports as JSON:
 * - health: /v2/health payload size and latency (target < 1 KB in <= 10 ms),
 *   next to the size of the legacy GET /sessions probe;
 * - load: state.json writes per minute and event-loop p99 with 5 live turns at
 *   the default 30 s checkpoint tick (targets <= 12/min and < 50 ms);
 * - stall: daemon RSS growth while one SSE consumer stays stalled during a
 *   streaming turn (target < 10 MB over 10 min; pass --stall-ms 600000).
 * Never point it at a deployment: it only talks to the daemon it starts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name: string, fallback: number): number => {
  const index = args.indexOf(name);
  const value = index >= 0 ? Number(args[index + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const WINDOW_MS = option("--window-ms", 120_000);
const STALL_MS = option("--stall-ms", 120_000);
const TOKEN = randomBytes(32).toString("base64url");
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address == null || typeof address === "string") reject(new Error("no port"));
        else resolvePort(address.port);
      });
    });
  });
}

function seedState(workspace: string): unknown {
  const at = Date.parse("2026-10-25T10:00:00.000Z");
  const sessions: Record<string, unknown> = {};
  for (let index = 0; index < 165; index += 1) {
    const name = `lab-history-${index}`;
    sessions[name] = {
      name,
      agent: "claude",
      directory: workspace,
      state: "idle",
      createdAt: new Date(at).toISOString(),
      lastActivity: new Date(at).toISOString(),
      permissionMode: "approve-reads",
      warnings: [],
      transcript: Array.from({ length: 28 }, (_, entry) => ({
        role: entry % 2 === 0 ? "user" : "assistant",
        text: `${entry}:`.padEnd(2_000, "x"),
        createdAt: new Date(at + entry * 1_000).toISOString()
      }))
    };
  }
  return { version: 1, sessions, turnRequests: {}, turnGenerations: {}, exposures: {}, quiescence: { lastEpoch: 0, active: {}, latestByName: {} } };
}

async function api(port: number, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: string; ms: number }> {
  const startedAt = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.body != null ? { "content-type": "application/json" } : {}) },
    ...(init.body != null ? { body: JSON.stringify(init.body) } : {})
  });
  const body = await response.text();
  return { status: response.status, body, ms: performance.now() - startedAt };
}

async function rssBytes(pid: number): Promise<number> {
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const match = /VmRSS:\s+(\d+)\s+kB/u.exec(status);
  return match ? Number(match[1]) * 1024 : 0;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
}

async function startDaemon(dataDir: string, configPath: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(repo, "dist", "daemon", "cli.js"), "start", "--port", String(port), "--data-dir", dataDir, "--config", configPath], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, PUPPENCLAW_BOOT_REAPER: "observe" }
  });
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.ok, () => false);
    if (ok) return child;
    await sleep(100);
  }
  child.kill("SIGKILL");
  throw new Error("daemon did not become healthy");
}

type Health = {
  eventLoop: { p99Ms: number; maxMs: number; windowMs: number };
  backlog: { streamBytes: number };
  memory: { rssBytes: number; heapUsedBytes: number };
};

async function prepare(withHistory: boolean): Promise<{ dataDir: string; workspace: string; configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "puppenclaw-measure-h4-"));
  const dataDir = join(root, "data");
  const workspace = join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  if (withHistory) {
    await writeFile(join(dataDir, "state.json"), JSON.stringify(seedState(workspace)), "utf8");
  }
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      daemonAuthToken: TOKEN,
      maxSessions: 10,
      acpxCommand: `${process.execPath} ${join(repo, "test", "fixtures", "fake-acpx-stream.mjs")}`
    }),
    "utf8"
  );
  return { dataDir, workspace, configPath };
}

async function stop(daemon: ChildProcess): Promise<void> {
  daemon.kill("SIGTERM");
  await new Promise((resolveExit) => daemon.once("exit", resolveExit));
}

/** Five live turns on a production-sized store, then health latency and size. */
async function loadAndHealth(report: Record<string, unknown>): Promise<void> {
  const { dataDir, workspace, configPath } = await prepare(true);
  report.stateBytes = (await readFile(join(dataDir, "state.json"))).length;
  const port = await freePort();
  const daemon = await startDaemon(dataDir, configPath, port);
  try {
    let stateWrites = 0;
    const watcher = watch(dataDir, (event, filename) => {
      if (event === "rename" && filename === "state.json") stateWrites += 1;
    });
    const chunks = Math.ceil((WINDOW_MS + 30_000) / 50);
    const turns = Array.from({ length: 5 }, (_, index) =>
      api(port, "/session/start", {
        method: "POST",
        body: {
          agent: "claude",
          name: `lab-live-${index}`,
          directory: workspace,
          task: `STREAM_CHUNKS=${chunks} STREAM_INTERVAL_MS=50 STREAM_CHUNK_CHARS=200 STREAM_ACTIVITY_EVERY=10 STREAM_NEWLINES`,
          resultView: "turn"
        }
      })
    );
    await sleep(5_000);
    const writesBefore = stateWrites;
    const windowStart = Date.now();
    let maxP99 = 0;
    let maxLag = 0;
    while (Date.now() - windowStart < WINDOW_MS) {
      await sleep(1_000);
      const health = JSON.parse((await api(port, "/v2/health")).body) as Health;
      // Count only lag windows that lie entirely inside the measured period.
      if (Date.now() - windowStart > 2 * health.eventLoop.windowMs + 2_000) {
        maxP99 = Math.max(maxP99, health.eventLoop.p99Ms);
        maxLag = Math.max(maxLag, health.eventLoop.maxMs);
      }
    }
    const windowMs = Date.now() - windowStart;
    const windowWrites = stateWrites - writesBefore;
    watcher.close();
    report.load = {
      liveTurns: 5,
      checkpointTickMs: Number(process.env.PUPPENCLAW_ACTIVE_TURN_CHECKPOINT_MS ?? 30_000),
      windowMs,
      stateWrites: windowWrites,
      stateWritesPerMinute: Number(((windowWrites * 60_000) / windowMs).toFixed(2)),
      eventLoopP99MaxMs: maxP99,
      eventLoopMaxMs: maxLag
    };
    for (let index = 0; index < 5; index += 1) {
      await api(port, `/session/lab-live-${index}`, { method: "DELETE" });
    }
    await Promise.allSettled(turns);

    const latencies: number[] = [];
    let healthBytes = 0;
    for (let index = 0; index < 200; index += 1) {
      const response = await api(port, "/v2/health");
      latencies.push(response.ms);
      healthBytes = Buffer.byteLength(response.body);
    }
    const legacy = await api(port, "/sessions");
    report.health = {
      bytes: healthBytes,
      p50Ms: Number(percentile(latencies, 0.5).toFixed(2)),
      p99Ms: Number(percentile(latencies, 0.99).toFixed(2)),
      legacySessionsBytes: Buffer.byteLength(legacy.body),
      legacySessionsMs: Number(legacy.ms.toFixed(1))
    };
  } finally {
    await stop(daemon);
  }
}

/**
 * One SSE consumer stops reading while its turn streams about 50 KB/s. The
 * daemon keeps each turn's full output until the turn ends, so the same run
 * with a reading consumer is the baseline; the difference is what the stalled
 * stream costs. Fresh daemon, small store, so GC noise stays low.
 */
async function stall(report: Record<string, unknown>): Promise<void> {
  const { dataDir, workspace, configPath } = await prepare(false);
  const port = await freePort();
  const daemon = await startDaemon(dataDir, configPath, port);
  const pid = daemon.pid!;
  const phase = async (name: string, stalled: boolean) => {
    const stallChunks = Math.ceil((STALL_MS + 30_000) / 20);
    const response = await new Promise<IncomingMessage>((resolveResponse, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/session/start/stream", method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } },
        resolveResponse
      );
      req.once("error", reject);
      req.end(
        JSON.stringify({
          agent: "claude",
          name,
          directory: workspace,
          task: `STREAM_CHUNKS=${stallChunks} STREAM_INTERVAL_MS=20 STREAM_CHUNK_CHARS=1000 STREAM_NEWLINES`,
          resultView: "turn"
        })
      );
    });
    if (stalled) {
      response.pause();
    } else {
      response.resume();
    }
    await sleep(15_000);
    const warmHealth = JSON.parse((await api(port, "/v2/health")).body) as Health;
    const rssWarm = await rssBytes(pid);
    const rss: number[] = [];
    const heap: number[] = [];
    let maxStreamBytes = 0;
    const startedAt = Date.now();
    while (Date.now() - startedAt < STALL_MS) {
      await sleep(5_000);
      rss.push(await rssBytes(pid));
      const health = JSON.parse((await api(port, "/v2/health")).body) as Health;
      heap.push(health.memory.heapUsedBytes);
      maxStreamBytes = Math.max(maxStreamBytes, health.backlog.streamBytes);
    }
    response.destroy();
    await api(port, `/session/${name}`, { method: "DELETE" });
    return {
      durationMs: Date.now() - startedAt,
      rssGrowthBytes: (rss.at(-1) ?? rssWarm) - rssWarm,
      rssPeakGrowthBytes: Math.max(...rss) - rssWarm,
      heapGrowthBytes: (heap.at(-1) ?? warmHealth.memory.heapUsedBytes) - warmHealth.memory.heapUsedBytes,
      maxStreamBacklogBytes: maxStreamBytes
    };
  };
  try {
    const reading = await phase("lab-reading-consumer", false);
    const stalled = await phase("lab-stalled-consumer", true);
    report.stall = {
      producedBytesPerSecond: 50_000,
      readingConsumer: reading,
      stalledConsumer: stalled,
      stallAttributableRssGrowthBytes: stalled.rssGrowthBytes - reading.rssGrowthBytes,
      stallAttributableHeapGrowthBytes: stalled.heapGrowthBytes - reading.heapGrowthBytes
    };
  } finally {
    await stop(daemon);
  }
}

async function main(): Promise<void> {
  const report: Record<string, unknown> = {};
  await loadAndHealth(report);
  await stall(report);
  console.log(JSON.stringify(report, null, 2));
}

await main();
