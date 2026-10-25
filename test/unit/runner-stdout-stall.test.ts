import { spawn } from "node:child_process";
import { request, type IncomingMessage } from "node:http";
import { chmod, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createDaemonServer } from "../../src/daemon/server.js";
import { createTempDir, makeConfig } from "../helpers.js";

/**
 * Plan H4: stall the runner's stdout reader for 30 s to find the source of the
 * Codex "failed printing to stdout: EAGAIN" panics.
 *
 * Finding: initialising process.stdout in a Node process (writing to it, or
 * even importing `node:process`) sets O_NONBLOCK on its stdout pipe. The flag
 * belongs to the open file description, which a child started with inherited
 * stdio shares. libuv resets inherited stdio to blocking at spawn, so the flag
 * bites when a Node wrapper initialises its stdout after spawning the native
 * runner, e.g. to write its own metadata lines onto the shared protocol
 * channel. From then on the runner's blocking-style writes fail with EAGAIN as
 * soon as the socket buffer (about 208 KiB) is full, i.e. whenever the daemon
 * reads the runner's stdout more slowly than the runner writes. With a
 * blocking stdout the same runner simply waits, even through a 30 s stall.
 * The daemon's side is to keep that reader moving: a slow SSE consumer no
 * longer slows it (bounded per-stream queue), and group commit removes most
 * long synchronous state writes from the event loop.
 */

const STALL_MS = Number(process.env.PUPPENCLAW_STDOUT_STALL_TEST_MS ?? 30_000);
const fakeAcpx = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-acpx.sh");

// Writes with blocking semantics, like a native runner: no retry on EAGAIN.
// About 4 KiB every 10 ms, a rate an unstalled reader keeps up with easily.
const WRITER = `import { writeSync } from "node:fs";
const total = Number(process.argv[2]);
const mode = process.argv[3] ?? "raw";
const pause = new Int32Array(new SharedArrayBuffer(4));
let written = 0;
let index = 0;
try {
  while (written < total) {
    Atomics.wait(pause, 0, 0, 10);
    const text = mode === "json"
      ? JSON.stringify({ type: "agent_message_chunk", content: { type: "text", text: (index++ + ":").padEnd(4000, "w") + "\\n" } }) + "\\n"
      : "r".repeat(Math.min(4096, total - written));
    const buffer = Buffer.from(text);
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(1, buffer, offset);
    written += mode === "json" ? 4001 : buffer.length;
  }
  if (mode === "json") writeSync(1, JSON.stringify({ type: "done", stopReason: "end_turn" }) + "\\n");
} catch (error) {
  writeSync(2, "EAGAIN_AFTER " + written + " " + error.code + "\\n");
  process.exit(75);
}
process.exit(0);
`;

// A Node wrapper that hands its own stdout to the writer and then writes one
// metadata line onto that shared stdout. Through process.stdout this makes the
// shared pipe non-blocking; through fs.writeSync(1) it stays blocking.
const wrapper = (nonBlocking: boolean, writer: string) => `import { writeSync } from "node:fs";
import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(writer)}, process.argv[2], process.argv[3] ?? "raw"], { stdio: ["ignore", "inherit", "inherit"] });
child.on("exit", (code) => process.exit(code ?? 1));
setTimeout(() => {
  const line = JSON.stringify({ type: "wrapper.metadata" }) + "\\n";
  ${nonBlocking ? "process.stdout.write(line);" : "writeSync(1, line);"}
}, 20);
`;

async function fixtures() {
  const dir = await createTempDir("puppenclaw-stdout-stall-");
  const writer = join(dir, "writer.mjs");
  await writeFile(writer, WRITER, "utf8");
  const nonBlocking = join(dir, "wrapper-nonblocking.mjs");
  const blocking = join(dir, "wrapper-blocking.mjs");
  await writeFile(nonBlocking, wrapper(true, writer), "utf8");
  await writeFile(blocking, wrapper(false, writer), "utf8");
  return { dir, writer, nonBlocking, blocking };
}

function runStalled(script: string, total: number, stallMs: number) {
  const child = spawn(process.execPath, [script, String(total)], { stdio: ["ignore", "pipe", "pipe"] });
  let received = 0;
  let stderr = "";
  child.stdout.pause();
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  let exitedDuringStall = false;
  const exited = new Promise<number | null>((resolveExit) => {
    child.once("close", (code) => resolveExit(code));
  });
  child.once("exit", () => {
    exitedDuringStall = !resumed;
  });
  let resumed = false;
  const done = (async () => {
    await new Promise((resolveStall) => setTimeout(resolveStall, stallMs));
    resumed = true;
    child.stdout.on("data", (chunk: Buffer) => {
      received += chunk.length;
    });
    child.stdout.resume();
    const code = await exited;
    return { code, received, stderr, exitedDuringStall };
  })();
  return done;
}

describe.runIf(process.platform === "linux")("runner stdout reader stalls", () => {
  it("a writer sharing a Node-made non-blocking stdout fails with EAGAIN once the reader stalls", async () => {
    const { nonBlocking } = await fixtures();
    const outcome = await runStalled(nonBlocking, 8 * 1024 * 1024, 5_000);
    expect(outcome.code).toBe(75);
    expect(outcome.exitedDuringStall).toBe(true);
    expect(outcome.stderr).toMatch(/EAGAIN_AFTER \d+ EAGAIN/u);
  }, 30_000);

  it(
    `the same writer with a blocking stdout waits out a ${STALL_MS / 1000} s reader stall and loses nothing`,
    async () => {
      const { blocking } = await fixtures();
      const total = 2 * 1024 * 1024;
      const outcome = await runStalled(blocking, total, STALL_MS);
      expect(outcome.exitedDuringStall).toBe(false);
      expect(outcome.code).toBe(0);
      expect(outcome.received).toBe(total + `${JSON.stringify({ type: "wrapper.metadata" })}\n`.length);
      expect(outcome.stderr).toBe("");
    },
    STALL_MS + 30_000
  );

  it("the daemon keeps reading such a runner while its SSE consumer stalls, so no EAGAIN occurs", async () => {
    const { dir, nonBlocking } = await fixtures();
    // acpx stand-in: prompts run the non-blocking wrapper, everything else is the fake runner.
    const acpx = join(dir, "acpx-eagain.sh");
    await writeFile(
      acpx,
      `#!/usr/bin/env bash\nfor arg in "$@"; do\n  if [[ "$arg" == "prompt" ]]; then\n    cat > /dev/null\n    exec ${JSON.stringify(process.execPath)} ${JSON.stringify(nonBlocking)} 2000000 json\n  fi\ndone\nexec ${JSON.stringify(fakeAcpx)} "$@"\n`,
      "utf8"
    );
    await chmod(acpx, 0o755);
    const workspace = await createTempDir("puppenclaw-stdout-stall-ws-");
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: acpx }),
      dataDir: await createTempDir("puppenclaw-stdout-stall-data-"),
      logger: { info() {}, warn() {}, error() {}, debug() {} }
    });
    const url = new URL(await app.listen({ host: "127.0.0.1", port: 0 }));
    try {
      const response = await new Promise<IncomingMessage>((resolveResponse, reject) => {
        const req = request(
          { host: url.hostname, port: url.port, path: "/session/start/stream", method: "POST", headers: { "content-type": "application/json" } },
          resolveResponse
        );
        req.once("error", reject);
        req.end(JSON.stringify({ agent: "claude", name: "lab-eagain", directory: workspace, task: "flood", resultView: "turn" }));
      });
      response.pause();
      // Wait for the settled turn; the status view can show "orphaned" for a moment
      // between the runner's exit and the turn's finalisation.
      let state: string | undefined;
      for (let attempt = 0; attempt < 1_200; attempt += 1) {
        const status = await app.inject({ method: "GET", url: "/session/lab-eagain?view=summary" });
        state = status.statusCode === 200
          ? (JSON.parse(status.body) as { details: { session: { activeTurn?: { state: string } } } }).details.session.activeTurn?.state
          : undefined;
        if (state === "completed" || state === "failed") {
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      // Completed (not failed): the writer never saw EAGAIN although nobody read the stream.
      expect(state).toBe("completed");
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.resume();
      await new Promise((resolveEnd) => response.once("end", resolveEnd));
      expect(body).toMatch(/event: result\n/u);
      expect(body).toMatch(/event: done\n/u);
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  }, 120_000);
});
