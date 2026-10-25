/**
 * Plan P1/P2 acceptance measurement: bulk completions per second and daemon
 * event-loop lag with the group-committed store, against a mock upstream.
 *
 *   node --experimental-strip-types scripts/measure-p1.mts [--items N] [--jobs N]
 *     [--streams N] [--latency-ms N] [--output-bytes N] [--only paced|max|hooks-off|no-group-commit]
 *
 * Each scenario runs in a fresh process (scripts/measure-p1-runner.mts, bundled
 * with esbuild) with the daemon's real receipt hooks: the statistics recorder
 * (one checkpoint per receipt update, /proc sampling) and the usage ledger.
 * The mock upstream runs in its own process so its work never lands on the
 * measured event loop. Reported lag uses monitorEventLoopDelay at 10 ms
 * resolution minus the resolution, as GET /v2/health does. Targets: at least
 * 200 completions/s with p99 < 50 ms; a worker-thread store host is only
 * warranted when p99 reaches 50 ms at 200 completions/s with in-thread group
 * commit. It only talks to the processes it starts.
 */
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name: string, fallback: number): number => {
  const index = args.indexOf(name);
  const value = index >= 0 ? Number(args[index + 1]) : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const items = option("--items", 4_000), jobs = option("--jobs", 2), streams = option("--streams", 60), outputBytes = option("--output-bytes", 2_300);

const outDir = await mkdtemp(join(tmpdir(), "measure-p1-build-"));
const runner = join(outDir, "runner.mjs");
await build({
  entryPoints: [join(repo, "scripts", "measure-p1-runner.mts")], outfile: runner, bundle: true, platform: "node", format: "esm", target: "node22",
  external: ["openclaw"], banner: { js: "import { createRequire as __pcCreateRequire } from 'node:module'; const require = __pcCreateRequire(import.meta.url);" }, logLevel: "silent"
});

async function scenario(name: string, config: Record<string, unknown>): Promise<unknown> {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [runner, JSON.stringify(config)], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("exit", (code) => {
      if (code !== 0) { reject(new Error(`${name} exited with ${code}`)); return; }
      resolveRun({ name, ...(JSON.parse(output.trim().split("\n").at(-1)!) as Record<string, unknown>) });
    });
  });
}

const base = { items, jobs, streams, outputBytes, hooks: true, commitWindowMs: 50 };
// paced: 60 streams at 250 ms upstream latency, about 230 completions/s; max: an instant upstream.
// *-store-only: without the statistics recorder and the usage ledger, i.e. the share a worker-thread
// store host could take off the loop. per-receipt-hooks: the hooks called once per receipt update, as
// before batching. no-group-commit: every store write in its own transaction.
const scenarios: [string, Record<string, unknown>][] = [
  ["paced", { ...base, latencyMs: option("--latency-ms", 250) }],
  ["max", { ...base, latencyMs: 1 }],
  ["paced-store-only", { ...base, latencyMs: option("--latency-ms", 250), hooks: false }],
  ["max-store-only", { ...base, latencyMs: 1, hooks: false }],
  ["per-receipt-hooks", { ...base, latencyMs: option("--latency-ms", 250), perReceiptHooks: true }],
  ["no-group-commit", { ...base, latencyMs: option("--latency-ms", 250), commitWindowMs: 0 }]
];
const results: unknown[] = [];
for (const [name, config] of scenarios) if (ONLY === undefined || ONLY === name) results.push(await scenario(name, config));
process.stdout.write(`${JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, results }, null, 2)}\n`);
