/**
 * Runner of scripts/measure-p1.mts (bundled with esbuild; never run against a deployment).
 * One scenario per process: a mock Responses upstream in a child process, the
 * advanced runtime with the daemon's real receipt hooks (statistics recorder
 * and usage ledger, as wired in src/daemon/server.ts), bulk jobs submitted over
 * the scoped worker socket, and the event loop sampled the way /v2/health does.
 */
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { AdvancedRuntime } from "../src/advanced/runtime.js";
import { BulkResponseTransport } from "../src/advanced/bulk-transport.js";
import { startParamsZod } from "../src/shared/schema.js";
import type { SessionInfo, UsageLedgerEntry } from "../src/shared/types.js";
import type { UsageReceipt } from "../src/advanced/types.js";
import { UsageLedgerStore } from "../src/shared/usage-ledger.js";
import { TurnStatisticsRecorder } from "../src/statistics/recorder.js";
import { TurnStatisticsStore } from "../src/statistics/store.js";

const config = JSON.parse(process.argv[2] ?? "{}") as { items: number; jobs: number; streams: number; latencyMs: number; hooks: boolean | "statistics" | "ledger"; commitWindowMs: number; outputBytes: number; perReceiptHooks?: boolean };
const statisticsHook = config.hooks === true || config.hooks === "statistics", ledgerHook = config.hooks === true || config.hooks === "ledger";

const UPSTREAM = `
const { createServer } = require("node:http");
const latency = Number(process.argv[1]), output = "x".repeat(Number(process.argv[2]));
const server = createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c));
  req.on("end", () => setTimeout(() => {
    const body = JSON.stringify({ model: "served-model", status: "completed", output_text: output, usage: { input_tokens: 540, output_tokens: 57 } });
    res.writeHead(200, { "content-type": "application/json", server: "mock-vllm", "content-length": Buffer.byteLength(body) }); res.end(body);
  }, latency));
});
server.keepAliveTimeout = 60000;
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
`;

function unix(socketPath: string, path: string, value?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false, method: value === undefined ? "GET" : "POST", headers: { "content-type": "application/json" } }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; }); res.once("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.once("error", reject); req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}

const upstream = spawn(process.execPath, ["-e", UPSTREAM, String(config.latencyMs), String(config.outputBytes)], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise<number>((resolve) => upstream.stdout!.once("data", (chunk: Buffer) => resolve(Number(String(chunk).trim()))));
const registered = "http://127.0.0.1:9/v1", direct = `http://127.0.0.1:${port}/v1`;

const root = await mkdtemp(join(tmpdir(), "measure-p1-"));
const statisticsStore = await TurnStatisticsStore.open(join(root, "statistics"));
// The real recorder, including its once-a-second /proc sampling of the metered turn.
const statistics = new TurnStatisticsRecorder(statisticsStore, { listComputeJobs: () => [] });
const ledger = await UsageLedgerStore.open(join(root, "usage"));
const runtime = await AdvancedRuntime.open(join(root, "advanced"), { defaultLimit: config.streams }, {
  store: { commitWindowMs: config.commitWindowMs },
  transport: new BulkResponseTransport(60_000, new Map([[registered, direct]]))
});
process.env.MEASURE_KEY = "measure-secret";
const provider = { id: "remote_qwen38_none", model: "chat", kind: "codex-openai-compatible" as const, baseUrl: registered, authTokenEnv: "MEASURE_KEY" };
const params = startParamsZod.parse({ name: "main", agent: "codex", directory: "/tmp", task: "census", interactionMode: "execute", permissionMode: "approve-all", statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt" }, modelProvider: provider, orchestration: { version: 1, revision: 1, workers: [{ id: "w1", assignment: "Judge", agent: "codex", modelProvider: provider }] } });
const session = { ...params, state: "running", warnings: [], transcript: [], createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() } as SessionInfo;
let contributions = 0;
/** The usage-ledger row of a settled broker call, as built in src/daemon/server.ts. */
const ledgerEntry = (receipt: UsageReceipt): UsageLedgerEntry | null => {
  if (receipt.state === "running" || receipt.usage.input === null || receipt.usage.output === null) return null;
  return { id: `advanced-${receipt.requestId}`, sessionName: receipt.parentSessionName, agent: "codex", provider: receipt.providerId, model: receipt.model,
    usage: { input: Math.max(0, receipt.usage.input - (receipt.usage.cacheRead ?? 0) - (receipt.usage.cacheWrite ?? 0)), output: receipt.usage.output, cacheRead: receipt.usage.cacheRead ?? 0, cacheWrite: receipt.usage.cacheWrite ?? 0, total: receipt.usage.total ?? receipt.usage.input + receipt.usage.output },
    durationMs: Date.parse(receipt.updatedAt) - Date.parse(receipt.createdAt), timestamp: receipt.updatedAt, turnId: receipt.attemptId, role: receipt.role, threads: 1 };
};
runtime.attach({
  start: async () => ({ content: [], details: {} }), quiesce: async () => {}, getSession: () => session,
  // The daemon's receipt hooks (src/daemon/server.ts): per receipt for native calls, per batch for bulk calls.
  contribution: (receipt) => {
    contributions += 1;
    if (statisticsHook) statistics.observeBrokerReceipt(receipt.parentSessionName, receipt);
    const entry = ledgerHook ? ledgerEntry(receipt) : null; if (entry) ledger.append(entry);
  },
  ...(config.perReceiptHooks ? {} : {
    contributions: (receipts) => {
      contributions += receipts.length;
      if (statisticsHook) statistics.observeBrokerReceipts("main", receipts);
      if (ledgerHook) ledger.appendMany(receipts.flatMap((receipt) => ledgerEntry(receipt) ?? []));
    }
  })
});
if (statisticsHook) statistics.admit({ version: 1, chatId: "chat", attemptId: "attempt" }, { name: "main", agent: "codex" }, "turn");
await runtime.begin(session, params, "approve-all");
const socket = runtime.socket("main")!;

// Warm up connections and code paths outside the measured window.
const warm = (await unix(socket, "/bulk/submit?view=summary", { configId: "w1", idempotencyKey: "warmup", concurrency: config.streams, items: Array.from({ length: config.streams * 2 }, (_, index) => ({ id: `w${index}`, input: `warm ${index}` })) })).body;
for (;;) { const job = (await unix(socket, `/jobs/${warm.jobId}?view=summary`)).body; if (!["queued", "running"].includes(job.state)) break; await new Promise((r) => setTimeout(r, 20)); }

const histogram = monitorEventLoopDelay({ resolution: 10 }), fine = monitorEventLoopDelay({ resolution: 1 });
histogram.enable(); fine.enable();
const batchesBefore = runtime.store.stats.batches, mutationsBefore = runtime.store.stats.mutations, startedAt = performance.now();
const entry = (index: number) => `CITING SENTENCE ${index}: ... [12]. CITED WORK: Title ${index}. Abstract ${"lorem ipsum ".repeat(150)}`;
const jobs: string[] = [];
for (let job = 0; job < config.jobs; job += 1) {
  const submitted = (await unix(socket, "/bulk/submit?view=summary", { configId: "w1", idempotencyKey: `measure-${job}`, concurrency: config.streams, items: Array.from({ length: config.items }, (_, index) => ({ id: `j${job}-i${index}`, input: entry(index) })) })).body;
  jobs.push(submitted.jobId);
}
const submitMs = performance.now() - startedAt;
// A second histogram from the end of the submissions: steady-state completions only.
const steady = monitorEventLoopDelay({ resolution: 10 }); steady.enable();
const polls: number[] = [];
for (;;) {
  const t = performance.now();
  const states = await Promise.all(jobs.map(async (id) => (await unix(socket, `/jobs/${id}?view=summary`)).body));
  polls.push(performance.now() - t);
  if (states.every((job) => !["queued", "running"].includes(job.state))) break;
  await new Promise((r) => setTimeout(r, 250));
}
const elapsedMs = performance.now() - startedAt;
histogram.disable(); fine.disable(); steady.disable();
const completions = jobs.reduce((sum, id) => sum + runtime.store.progress(id).completed, 0);
const receipts = jobs.flatMap((id) => runtime.store.jobReceipts(id));
const events = runtime.store.events(0, 1_000_000).events;
const result = {
  scenario: config,
  completions, elapsedMs: Math.round(elapsedMs), completionsPerSecond: Math.round((completions / elapsedMs) * 1000),
  eventLoop: { p99LagMs: Math.max(0, histogram.percentile(99) / 1e6 - 10), maxLagMs: Math.max(0, histogram.max / 1e6 - 10), p99LagMsAt1msResolution: Math.max(0, fine.percentile(99) / 1e6 - 1), meanLagMsAt1msResolution: Math.max(0, fine.mean / 1e6 - 1),
    afterSubmission: { p99LagMs: Math.max(0, steady.percentile(99) / 1e6 - 10), maxLagMs: Math.max(0, steady.max / 1e6 - 10) } },
  submitMs: Math.round(submitMs),
  store: { batches: runtime.store.stats.batches - batchesBefore, writes: runtime.store.stats.mutations - mutationsBefore, writesPerBatch: Math.round(((runtime.store.stats.mutations - mutationsBefore) / Math.max(1, runtime.store.stats.batches - batchesBefore)) * 10) / 10, fallbacks: runtime.store.stats.fallbacks },
  receipts: receipts.length, receiptsWithFingerprintAndSettings: receipts.filter((row) => (row.serverFingerprint ?? "") !== "" && /^[0-9a-f]{64}$/u.test(row.settingsSha256 ?? "")).length,
  outbox: { receiptEvents: events.filter((event) => event.type === "broker.receipt").length, head: runtime.store.head() },
  pollMsP99: polls.sort((a, b) => a - b)[Math.floor((polls.length - 1) * 0.99)] ?? 0,
  contributions
};
process.stdout.write(`${JSON.stringify(result)}\n`);
await runtime.close(); await statistics.close(); ledger.close(); upstream.kill();
process.exit(0);
