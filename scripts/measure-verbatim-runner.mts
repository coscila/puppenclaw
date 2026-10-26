/**
 * Runner of scripts/measure-verbatim.mts (bundled with esbuild; never run against a deployment).
 * One scenario per process: a mock chat-completions upstream in a child process that
 * reports the sha256 of every request body, the advanced runtime with a run principal
 * granted one verbatim instrument, census-shaped verbatim calls submitted over the
 * principal socket, and the event loop sampled the way /v2/health does.
 */
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createInterface } from "node:readline";

import { BulkResponseTransport } from "../src/advanced/bulk-transport.js";
import { PrincipalRegistry } from "../src/advanced/principals.js";
import { AdvancedRuntime } from "../src/advanced/runtime.js";
import type { UsageReceipt } from "../src/advanced/types.js";
import { TurnStatisticsRecorder } from "../src/statistics/recorder.js";
import { TurnStatisticsStore } from "../src/statistics/store.js";

const config = JSON.parse(process.argv[2] ?? "{}") as { calls: number; jobs: number; submitters: number; streams: number; entries: number; entryBytes: number; systemBytes: number; outputBytes: number; latencyMs: number };

const UPSTREAM = `
const { createHash } = require("node:crypto");
const { createServer } = require("node:http");
const latency = Number(process.argv[1]), output = "x".repeat(Number(process.argv[2]));
const server = createServer((req, res) => {
  const hash = createHash("sha256"); req.on("data", (c) => hash.update(c));
  req.on("end", () => {
    process.stdout.write(hash.digest("hex") + " " + req.url + "\\n");
    setTimeout(() => {
      const body = JSON.stringify({ id: "chatcmpl-m", object: "chat.completion", model: "judge-served", system_fingerprint: "fp_mock",
        choices: [{ index: 0, message: { role: "assistant", content: output }, finish_reason: "stop" }], usage: { prompt_tokens: 31000, completion_tokens: 2300, total_tokens: 33300 } });
      res.writeHead(200, { "content-type": "application/json", server: "mock-vllm", "content-length": Buffer.byteLength(body) }); res.end(body);
    }, latency);
  });
});
server.keepAliveTimeout = 60000;
server.listen(0, "127.0.0.1", () => process.stdout.write("port " + String(server.address().port) + "\\n"));
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
const received: { digest: string; path: string }[] = [];
let resolvePort!: (port: number) => void;
const portReady = new Promise<number>((resolve) => { resolvePort = resolve; });
createInterface({ input: upstream.stdout! }).on("line", (line) => {
  const [first, second] = line.split(" ");
  if (first === "port") resolvePort(Number(second)); else received.push({ digest: first!, path: second! });
});
const port = await portReady;
const registered = "http://127.0.0.1:9/v1", direct = `http://127.0.0.1:${port}/v1`;

const root = await mkdtemp(join(tmpdir(), "measure-verbatim-"));
const statisticsStore = await TurnStatisticsStore.open(join(root, "statistics"));
const statistics = new TurnStatisticsRecorder(statisticsStore, { listComputeJobs: () => [] });
const runtime = await AdvancedRuntime.open(join(root, "advanced"), { defaultLimit: config.streams }, { transport: new BulkResponseTransport(60_000, new Map([[registered, direct]])) });
process.env.MEASURE_KEY = "measure-secret";
const provider = { id: "judge", model: "judge-model", kind: "codex-openai-compatible" as const, baseUrl: registered, authTokenEnv: "MEASURE_KEY", reasoningProfile: "qwen-3.8" as const };
let contributions = 0;
// The daemon's hooks (src/daemon/server.ts): statistics per session; a principal's receipts have no chat session, so no ledger rows.
runtime.attach({
  start: async () => ({ content: [], details: {} }), quiesce: async () => {}, getSession: () => null,
  contribution: (receipt: UsageReceipt) => { contributions += 1; statistics.observeBrokerReceipt(receipt.parentSessionName, receipt); },
  contributions: (receipts: UsageReceipt[]) => {
    contributions += receipts.length;
    const bySession = new Map<string, UsageReceipt[]>();
    for (const receipt of receipts) bySession.set(receipt.parentSessionName, [...bySession.get(receipt.parentSessionName) ?? [], receipt]);
    for (const [name, list] of bySession) statistics.observeBrokerReceipts(name, list);
  }
});
const registry = await PrincipalRegistry.open({ dataDir: root, runtime, providers: new Map([[provider.id, provider]]) });
await runtime.recover();

const SYSTEM = `You audit citation support. For each item emit one JSONL line.\n${"Rules: judge only from the evidence given. ".repeat(Math.ceil(config.systemBytes / 10))}`.slice(0, config.systemBytes);
const DIGEST = "e".repeat(64);
runtime.installInstrument(DIGEST, { instrumentId: "citation-census@1", version: 1, systemPrompt: SYSTEM, responseSchema: null, maxOutputTokens: { perItem: 700, minimum: 3000 },
  temperature: 0, seed: null, reasoning: "none", itemsPerCall: config.entries, requiredModelFingerprint: "judge-served", transport: { messages: "verbatim" } });
const socket = (await registry.put("run:measure", { kind: "run", runId: "measure", ownerKey: "owner-key-0123456789abcdef",
  grants: { providers: [provider.id], instruments: [DIGEST], maxConcurrency: config.streams, maxItems: null, tokenBudget: null, expiresAt: null }, socket: true })).socketPath!;

const evidence = "Abstract: lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(Math.ceil(config.entryBytes / 10)).slice(0, config.entryBytes);
const userMessage = (call: number, entries: number) => {
  const lines = [`Review article under audit: synthetic review ${call}`, "", `ITEMS (${entries}):`];
  for (let entry = 1; entry <= entries; entry += 1) lines.push(`### id=${entry}`, `REVIEW SAYS: [Body] A claim about topic ${call}-${entry} [${entry}].`, `CITED WORK: Title ${entry} | Venue | 2021`, `ABSTRACT: ${evidence}`);
  lines.push("", `Emit exactly ${entries} JSONL lines.`);
  return lines.join("\n");
};
const item = (id: string, call: number, entries: number) => ({ id, input: { model: provider.model, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: userMessage(call, entries) }],
  max_tokens: Math.max(3000, 700 * entries), temperature: 0.0, stream: false, reasoning_effort: "none", itemCount: entries } });
/**
 * Waits until every given job has settled, reading the principal's job summaries page by page every 250 ms
 * (as an executor does; one connection at a time); returns the duration of each poll round.
 */
const settle = async (ids: string[]) => {
  const polls: number[] = [];
  for (;;) {
    const t = performance.now(), states = new Map<string, string>();
    for (let after = 0; ;) {
      const page = (await unix(socket, `/jobs?view=summary&after=${after}&limit=1000`)).body as { jobs: { jobId: string; state: string }[]; nextCursor: number; hasMore: boolean };
      for (const job of page.jobs) states.set(job.jobId, job.state);
      if (!page.hasMore) break;
      after = page.nextCursor;
    }
    polls.push(performance.now() - t);
    if (ids.every((id) => { const state = states.get(id); return state !== undefined && !["queued", "running"].includes(state); })) return polls;
    await new Promise((r) => setTimeout(r, 250));
  }
};

// Warm up connections and code paths outside the measured window.
const warm = (await unix(socket, "/bulk/submit?view=summary", { configId: provider.id, idempotencyKey: "warmup", instrumentDigest: DIGEST, concurrency: config.streams, items: Array.from({ length: config.streams * 2 }, (_, index) => item(`w${index}`, index, 1)) })).body;
await settle([warm.jobId]);

const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
const startedAt = performance.now(), submitMs: number[] = [], jobs: string[] = [];
// Submitters run side by side, as an executor's call threads do (one call per job when --calls is 1).
let nextJob = 0;
await Promise.all(Array.from({ length: Math.max(1, config.submitters) }, async () => {
  while (nextJob < config.jobs) {
    const job = nextJob++;
    const items = Array.from({ length: config.calls }, (_, index) => item(`j${job}-c${index}`, job * config.calls + index, config.entries));
    const t = performance.now();
    const submitted = (await unix(socket, "/bulk/submit?view=summary", { configId: provider.id, idempotencyKey: `measure-${job}`, instrumentDigest: DIGEST, concurrency: config.streams, items })).body;
    submitMs.push(performance.now() - t);
    if (!submitted.jobId) throw new Error(`submit failed: ${JSON.stringify(submitted)}`);
    jobs.push(submitted.jobId);
  }
}));
const steady = monitorEventLoopDelay({ resolution: 10 }); steady.enable();
const polls = await settle(jobs);
const elapsedMs = performance.now() - startedAt;
histogram.disable(); steady.disable();
const results = jobs.flatMap((id) => runtime.store.job(id)!.results);
const completed = results.filter((result) => result.state === "completed");
const receipts = jobs.flatMap((id) => runtime.store.jobReceipts(id));
const events = runtime.store.events(0, 1_000_000).events.filter((event) => event.type === "broker.receipt" && jobs.includes(event.jobId));
// Byte identity at scale: every measured call's bytes, as the upstream hashed them, equal its receipt's requestSha256.
await new Promise((r) => setTimeout(r, 100));
const upstreamDigests = new Map<string, number>();
for (const entry of received) if (entry.path === "/v1/chat/completions") upstreamDigests.set(entry.digest, (upstreamDigests.get(entry.digest) ?? 0) + 1);
const matching = receipts.filter((receipt) => receipt.requestSha256 !== undefined && upstreamDigests.has(receipt.requestSha256)).length;
const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
const result = {
  scenario: config,
  calls: completed.length, entries: completed.length * config.entries, elapsedMs: Math.round(elapsedMs),
  callsPerSecond: Math.round((completed.length / elapsedMs) * 1000 * 10) / 10, entriesPerSecond: Math.round((completed.length * config.entries / elapsedMs) * 1000),
  userMessageBytes: Buffer.byteLength(userMessage(0, config.entries)), systemPromptBytes: Buffer.byteLength(SYSTEM),
  submitMs: { median: Math.round(sorted(submitMs)[Math.floor(submitMs.length / 2)] ?? 0), max: Math.round(Math.max(...submitMs)) },
  eventLoop: { p99LagMs: Math.max(0, histogram.percentile(99) / 1e6 - 10), maxLagMs: Math.max(0, histogram.max / 1e6 - 10), afterSubmission: { p99LagMs: Math.max(0, steady.percentile(99) / 1e6 - 10), maxLagMs: Math.max(0, steady.max / 1e6 - 10) } },
  receipts: receipts.length, receiptsWithRequestSha256: receipts.filter((receipt) => /^[0-9a-f]{64}$/u.test(receipt.requestSha256 ?? "")).length,
  receiptsWithFingerprintAndSettings: receipts.filter((receipt) => (receipt.serverFingerprint ?? "") !== "" && /^[0-9a-f]{64}$/u.test(receipt.settingsSha256 ?? "")).length,
  receiptsWhoseBytesTheUpstreamHashedIdentically: matching, refusedItems: results.filter((r) => r.errorCode === "INSTRUMENT_MESSAGE_MISMATCH").length,
  receiptEvents: events.length, receiptEventsWithRequestSha256: events.filter((event) => typeof (event.payload as { requestSha256?: unknown }).requestSha256 === "string").length,
  pollMsP99: sorted(polls)[Math.floor((polls.length - 1) * 0.99)] ?? 0, contributions
};
process.stdout.write(`${JSON.stringify(result)}\n`);
await registry.shutdown(); await runtime.close(); await registry.close(); await statistics.close(); upstream.kill();
process.exit(0);
