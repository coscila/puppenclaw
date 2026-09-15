import { readFileSync, writeFileSync, writeSync } from "node:fs";

const args = process.argv.slice(2);
const outputPath = args[args.indexOf("--output-last-message") + 1];
const prompt = readFileSync(0, "utf8");
const scenario = /SCENARIO:([a-z-]+)/u.exec(prompt)?.[1] ?? "file";
const emit = (value) => writeSync(1, `${JSON.stringify(value)}\n`);
emit({ type: "thread.started", thread_id: "fixture-thread" });
emit({ type: "turn.started" });
emit({ type: "item.started", item: { id: "tool", type: "command_execution", command: "date", status: "in_progress" } });
emit({ type: "item.completed", item: { id: "tool", type: "command_execution", command: "date", aggregated_output: "tool result", exit_code: 0, status: "completed" } });
emit({ type: "item.completed", item: { id: "progress", type: "agent_message", phase: "commentary", text: "Working on the references." } });
if (scenario === "sigterm" || scenario === "sigkill") {
  process.kill(process.pid, scenario === "sigterm" ? "SIGTERM" : "SIGKILL");
  await new Promise(() => {});
}
if (scenario === "stop") {
  writeFileSync("ready", "ready");
  await new Promise(() => setInterval(() => {}, 1000));
}
if (["error", "failed", "transient"].includes(scenario)) {
  emit({ type: "error", message: "connection reset token=fixture-secret" });
}
if (scenario === "failed") {
  // A stale final file cannot override a native terminal failure.
  writeFileSync(outputPath, "Incomplete file answer.");
  emit({ type: "turn.failed", error: { message: "Native turn failed token=fixture-secret" } });
  process.exit(0);
}
if (["file", "transient", "json-final"].includes(scenario)) {
  const item = { id: "final", type: "agent_message", phase: "final_answer", text: "Explicit JSON final." };
  emit({ type: "item.completed", item });
  emit({ type: "item.completed", item });
  if (scenario !== "json-final") writeFileSync(outputPath, "Authoritative file answer.");
}
emit({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } });

