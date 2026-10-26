/**
 * Verbatim instrument measurement (plan P2, decision "Instrument verbatim mode"):
 * calls and entries per second, daemon event-loop lag and per-call byte identity
 * for census-shaped verbatim calls through a run principal socket, against a mock
 * chat-completions upstream.
 *
 *   node --experimental-strip-types scripts/measure-verbatim.mts [--calls N] [--jobs N]
 *     [--submitters N] [--streams N] [--entries N] [--entry-bytes N] [--system-bytes N]
 *     [--latency-ms N] [--output-bytes N] [--only paced|max]
 *
 * `--calls 1 --jobs 800 --submitters 60` follows an executor that submits each
 * call as its own one-item job from 60 threads.
 *
 * Each scenario runs in a fresh process (scripts/measure-verbatim-runner.mts,
 * bundled with esbuild) with the daemon's receipt hooks wired as in
 * src/daemon/server.ts. The mock upstream runs in its own process, hashes every
 * request body it receives and reports the digests, so the runner can check that
 * each call's bytes hash to its receipt's requestSha256. It only talks to the
 * processes it starts.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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

const outDir = await mkdtemp(join(tmpdir(), "measure-verbatim-build-"));
const runner = join(outDir, "runner.mjs");
await build({
  entryPoints: [join(repo, "scripts", "measure-verbatim-runner.mts")], outfile: runner, bundle: true, platform: "node", format: "esm", target: "node22",
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

// Census geometry: 40 entries per call, about 3 KB of evidence per entry, a few KB of instructions.
const base = {
  calls: option("--calls", 100), jobs: option("--jobs", 8), submitters: option("--submitters", 1), streams: option("--streams", 60), entries: option("--entries", 40),
  entryBytes: option("--entry-bytes", 3_000), systemBytes: option("--system-bytes", 6_000), outputBytes: option("--output-bytes", 2_400)
};
const scenarios: [string, Record<string, unknown>][] = [
  ["paced", { ...base, latencyMs: option("--latency-ms", 250) }],
  ["max", { ...base, latencyMs: 1 }]
];
const results: unknown[] = [];
try { for (const [name, config] of scenarios) if (ONLY === undefined || ONLY === name) results.push(await scenario(name, config)); }
finally { await rm(outDir, { recursive: true, force: true }); }
process.stdout.write(`${JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, results }, null, 2)}\n`);
