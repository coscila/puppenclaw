import { readFileSync, writeFileSync, writeSync } from "node:fs";

// Fake OCSL Codex wrapper: native `codex exec --json` events followed by the
// wrapper's trailing `ocsl.model_usage` line (written after Codex exited).
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("--output-last-message") + 1];
const prompt = readFileSync(0, "utf8");
const scenario = /SCENARIO:([a-z-]+)/u.exec(prompt)?.[1] ?? "line";
const emit = (value, newline = true) => writeSync(1, `${typeof value === "string" ? value : JSON.stringify(value)}${newline ? "\n" : ""}`);

const usage = (input, cached, output, reasoning = 0, cacheWrite = 0) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: cacheWrite,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output
});
const line = (scale = 1) => ({
  type: "ocsl.model_usage",
  version: 1,
  threads: [
    { threadId: "main", parentThreadId: null, role: "main", agentRole: null, model: "gpt-6-luna",
      usage: usage(1000 * scale, 600 * scale, 50 * scale, 10 * scale, 100 * scale) },
    { threadId: "worker-1", parentThreadId: "main", role: "subagent", agentRole: "worker", model: "chat",
      usage: usage(40000 * scale, 30000 * scale, 2000 * scale, 1500 * scale) },
    { threadId: "worker-2", parentThreadId: "main", role: "subagent", agentRole: "worker", model: "chat",
      usage: usage(60000 * scale, 50000 * scale, 3000 * scale, 2500 * scale) }
  ]
});

emit({ type: "thread.started", thread_id: "main" });
emit({ type: "turn.started" });
emit({ type: "item.started", item: { id: "spawn", type: "collab_tool_call", tool: "spawn_agent", sender_thread_id: "main", receiver_thread_ids: [], prompt: "Check the references", agents_states: {}, status: "in_progress" } });
emit({ type: "item.completed", item: { id: "spawn", type: "collab_tool_call", tool: "spawn_agent", sender_thread_id: "main", receiver_thread_ids: ["worker-1"], prompt: "Check the references", agents_states: {}, status: "completed" } });
if (scenario === "failed") {
  emit({ type: "turn.failed", error: { message: "Native turn failed" }, usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 } });
  emit(line());
  process.exit(1);
}
emit({ type: "item.completed", item: { id: "final", type: "agent_message", phase: "final_answer", text: "Model usage final answer." } });
writeFileSync(outputPath, "Model usage final answer.");
emit({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } });
if (scenario === "line") emit(line());
if (scenario === "trailing") emit(line(), false);
if (scenario === "last-wins") {
  emit(line(1000));
  emit(line(2));
}
if (scenario === "invalid-after-valid") {
  emit(line());
  emit({ ...line(), version: 2 });
  emit({ ...line(), threads: [{ ...line().threads[0], usage: { ...line().threads[0].usage, input_tokens: -1 } }] });
  emit('{"type":"ocsl.model_usage","version":1,"threads":[');
}
if (scenario === "invalid") {
  emit({ type: "ocsl.model_usage", version: 1, threads: [{ threadId: "main", parentThreadId: "someone", role: "main", agentRole: null, model: "gpt-6-luna", usage: usage(1, 0, 1) }] });
  emit({ type: "ocsl.model_usage", version: 1, threads: "not-an-array", message: "assistant text must not leak" });
  emit({ type: "ocsl.unknown_metadata", item: { type: "agent_message", text: "must not leak" } });
}
