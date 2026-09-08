import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const cwd = args[args.indexOf("--cwd") + 1];
const marker = join(cwd, ".fake-reconnect-output");
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
if (existsSync(join(cwd, ".slow-runtime-controls")) &&
    (args.includes("cancel") || args.includes("close") || args.includes("status"))) {
  await delay(1200);
}
if (args.includes("prompt")) {
  const prompt = readFileSync(0, "utf8");
  if (prompt.includes("simulate-reconnect-auth") || prompt.includes("simulate-reconnect-answer")) {
    writeFileSync(marker, prompt.includes("simulate-reconnect-auth")
      ? "Failed to authenticate: OAuth session expired and could not be refreshed"
      : "I documented why OAuth credentials expire; the synthetic task is complete.");
    emit({ type: "error", code: "CONNECTION_FAILED", message: "Session needs reconnect" });
    process.exit(1);
  }
  emit({ type: "agent_message_chunk", content: { type: "text", text: "Synthetic turn complete." } });
  emit({ type: "done" });
  process.exit(0);
}
if (args.includes("show") && existsSync(marker)) {
  emit({ messages: [{ Agent: { content: [{ type: "text", text: readFileSync(marker, "utf8") }] } }] });
} else {
  await import("./fake-acpx.mjs");
}
