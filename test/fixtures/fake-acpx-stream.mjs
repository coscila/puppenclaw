#!/usr/bin/env node
// Streaming variant of the fake acpx runner. `prompt` is handled here; every
// other command is delegated to fake-acpx.sh, so sessions behave as there.
//
// Directives in the prompt text (all optional):
//   STREAM_CHUNKS=<n>          chunk events to emit (default: one reply chunk)
//   STREAM_INTERVAL_MS=<ms>    delay between chunks (default 20)
//   STREAM_CHUNK_CHARS=<n>     characters per chunk (default 40)
//   STREAM_ACTIVITY_EVERY=<k>  a tool_call activity event after every k chunks
//   FLOOD_BYTES=<n>            chunk text to emit as fast as stdout accepts it
//   FLOOD_CHUNK_CHARS=<n>      characters per flood chunk (default 16384)
//   FINAL_NEWLINE              end the reply with a newline
// Note: no `import process from "node:process"`. Importing that module
// initialises process.stdin/stdout, which sets O_NONBLOCK on the inherited
// stdio pipes; a synchronous read of a non-blocking stdin then fails with EAGAIN.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const promptIndex = args.indexOf("prompt");
if (promptIndex < 0 || args[promptIndex + 1] !== "--session") {
  const fake = fileURLToPath(new URL("./fake-acpx.sh", import.meta.url));
  const result = spawnSync(fake, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const name = args[promptIndex + 2] ?? "";
const cwdIndex = args.indexOf("--cwd");
const cwd = cwdIndex >= 0 ? (args[cwdIndex + 1] ?? process.cwd()) : process.cwd();
const prompt = await new Promise((resolve, reject) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    text += chunk;
  });
  process.stdin.once("end", () => resolve(text));
  process.stdin.once("error", reject);
});
const directive = (key, fallback) => {
  const match = new RegExp(`${key}=(\\d+)`, "u").exec(prompt);
  return match ? Number(match[1]) : fallback;
};

function emit(event) {
  return new Promise((resolve) => {
    if (process.stdout.write(`${JSON.stringify(event)}\n`)) {
      resolve();
    } else {
      process.stdout.once("drain", resolve);
    }
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!existsSync(join(cwd, ".fake-acpx-state", `${basename(name)}.session`))) {
  await emit({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32002, message: "No acpx session found", data: { acpxCode: "NO_SESSION", origin: "cli" } }
  });
  process.exit(4);
}

await emit({
  type: "usage_update",
  used: prompt.length,
  size: 4096,
  input_tokens: prompt.length,
  output_tokens: 12,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0
});

const floodBytes = directive("FLOOD_BYTES", 0);
const chunks = directive("STREAM_CHUNKS", 0);
if (floodBytes > 0) {
  const size = directive("FLOOD_CHUNK_CHARS", 16_384);
  let sent = 0;
  let index = 0;
  while (sent < floodBytes) {
    const text = `[${index}]`.padEnd(Math.min(size, floodBytes - sent), "f");
    await emit({ type: "agent_message_chunk", content: { type: "text", text } });
    sent += text.length;
    index += 1;
  }
} else if (chunks > 0) {
  const interval = directive("STREAM_INTERVAL_MS", 20);
  const size = directive("STREAM_CHUNK_CHARS", 40);
  const activityEvery = directive("STREAM_ACTIVITY_EVERY", 0);
  for (let index = 0; index < chunks; index += 1) {
    await emit({ type: "agent_message_chunk", content: { type: "text", text: `<${index}>`.padEnd(size, ".") } });
    if (activityEvery > 0 && (index + 1) % activityEvery === 0) {
      await emit({ sessionUpdate: "tool_call", toolCallId: `tool-${index}`, title: `step ${index}`, status: "completed" });
    }
    if (interval > 0) {
      await sleep(interval);
    }
  }
} else {
  await emit({ type: "agent_message_chunk", content: { type: "text", text: `Handled: ${prompt.trim().replace(/\s+/gu, " ")}` } });
}
if (prompt.includes("FINAL_NEWLINE")) {
  await emit({ type: "agent_message_chunk", content: { type: "text", text: "\n" } });
}
await emit({ type: "done", stopReason: "end_turn" });
