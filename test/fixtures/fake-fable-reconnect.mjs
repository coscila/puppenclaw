import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const cwd = args[args.indexOf("--cwd") + 1];
const marker = join(cwd, ".fake-reconnect-output");
const optionsPath = join(cwd, ".fake-reconnect-options.json");
const attemptsPath = join(cwd, ".fake-reconnect-attempts");
const options = existsSync(optionsPath) ? JSON.parse(readFileSync(optionsPath, "utf8")) : {};
const record = () => existsSync(marker)
  ? JSON.parse(readFileSync(marker, "utf8")) : { acpxRecordId: "reconnect-fixture", messages: [] };
const saveOutput = (prompt, text, extra = {}) => {
  const before = record();
  writeFileSync(marker, JSON.stringify({ ...before, ...extra, messages: [
    ...(options.dropOldMessages ? [] : before.messages),
    { User: { id: `new-${readFileSync(attemptsPath, "utf8")}`, content: [{ Text: prompt }] } },
    { Agent: { content: [{ Text: text }] } }
  ] }));
};
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
if (existsSync(join(cwd, ".slow-runtime-controls")) &&
    (args.includes("cancel") || args.includes("close") || args.includes("status"))) {
  await delay(1200);
}
if (args.includes("prompt")) {
  const prompt = readFileSync(0, "utf8");
  const attempt = existsSync(attemptsPath) ? Number(readFileSync(attemptsPath, "utf8")) + 1 : 1;
  writeFileSync(attemptsPath, String(attempt));
  process.stderr.write("[acpx] session synthetic · agent needs reconnect\n");
  if (options.kind != null) {
    if (options.kind === "plan-permission") {
      const sessionId = "native-plan-session";
      const update = (value) => emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
      emit({ jsonrpc: "2.0", id: 7, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: prompt }] } });
      const tool = (id, name, status, extra = {}) => update({ sessionUpdate: status === "pending" ? "tool_call" : "tool_call_update",
        toolCallId: id, _meta: { claudeCode: { toolName: name } }, status, ...extra });
      if (options.recoveryHandoff) {
        tool("old-mode", "ExitPlanMode", "pending");
        tool("old-mode", "ExitPlanMode", "failed", { content: [{ type: "content", content: { type: "text", text: "You are not in plan mode." } }] });
        tool("enter-plan", "EnterPlanMode", "pending");
        update({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
        tool("enter-plan", "EnterPlanMode", "completed");
      }
      for (let index = 0; index < (options.denials ?? 1); index++) {
        if (options.recoveryHandoff) tool(`plan-${index}`, "ExitPlanMode", "pending");
        emit({ jsonrpc: "2.0", id: index, method: "session/request_permission", params: {
          sessionId, toolCall: { toolCallId: `plan-${index}`, title: "Ready to code?", kind: options.permissionKind ?? "switch_mode",
            ...(options.recoveryHandoff ? { content: [{ type: "content", content: { type: "text", text: "# Recovery plan\n\nInspect preserved outputs, then resume after approval." } }] } : {}) },
          options: [{ optionId: "default", kind: "allow_once", name: "Yes" },
            { optionId: "plan", kind: "reject_once", name: "No, keep planning" }]
        } });
        if (!options.missingPermissionResponse) emit({ jsonrpc: "2.0", id: index,
          result: { outcome: { outcome: "selected", optionId: options.selectedOption ?? "plan" } } });
        if (options.recoveryHandoff) tool(`plan-${index}`, "ExitPlanMode", "failed", {
          content: [{ type: "content", content: { type: "text", text: "User rejected request to exit plan mode." } }] });
      }
      if (options.recoveryHandoff) {
        tool("ask-change", "AskUserQuestion", "pending", { rawInput: { question: "Which change is needed?" } });
        if (options.questionStatus !== "pending") tool("ask-change", "AskUserQuestion", options.questionStatus ?? "failed", {
          content: [{ type: "content", content: { type: "text", text: "AskUserQuestion is disabled for this session." } }] });
      }
      if (!options.noFreshOutput) update({ sessionUpdate: "agent_message_chunk", content: { type: "text",
        text: options.recoveryHandoff ? "You declined the recovery plan. What should change?" : "The completed plan is ready for your approval." } });
      if (!options.missingTerminal) emit({ jsonrpc: "2.0", id: options.wrongTerminal ? 8 : 7, result: { stopReason: "end_turn" } });
      if (options.errorAfterDone) emit({ type: "error", code: "CONNECTION_FAILED", message: "Actual failure after done" });
      if (options.signal) {
        process.kill(process.pid, options.signal);
        await delay(1000);
      }
      process.exit(options.exitCode ?? 5);
    }
    if (options.kind === "stale") {
      writeFileSync(marker, JSON.stringify({ ...record(), updated_at: new Date().toISOString() }));
      emit({ type: "error", code: "CONNECTION_FAILED", message: "ACP agent disconnected during request" });
      process.exit(1);
    }
    if (options.kind === "banner-success") {
      emit({ type: "status", text: "agent needs reconnect" });
      emit({ type: "agent_message_chunk", content: { type: "text", text: "Fresh answer." } });
      emit({ type: "done", stopReason: "end_turn" });
      process.exit(0);
    }
    if (options.kind === "queue") {
      if (attempt === 1 || options.alwaysReject) {
        if (options.activity === "tool") emit({ type: "tool_call", title: "Synthetic write", toolCallId: "t1" });
        if (options.activity === "text") emit({ type: "agent_message_chunk", content: { type: "text", text: "Partial work." } });
        if (options.activity === "raw") emit({ text: "Untyped partial work." });
        if (options.activity === "usage") emit({ type: "status", text: "usage recorded", usage: { input_tokens: 7, output_tokens: 2 } });
        if (options.appendUser) saveOutput(prompt, "");
        emit({ type: "error", code: "CONNECTION_FAILED", origin: options.origin ?? "queue",
          detailCode: options.detailCode ?? "QUEUE_OWNER_OVERLOADED", retryable: options.retryable ?? true,
          message: "Synthetic queue rejection" });
        process.exit(1);
      }
      emit({ type: "agent_message_chunk", content: { type: "text", text: "Retried once." } });
      emit({ type: "done", stopReason: "end_turn" });
      process.exit(0);
    }
    if (options.kind === "missing-terminal") {
      saveOutput(prompt, "Partial work, not completed.");
      emit({ type: "agent_message_chunk", content: { type: "text", text: "Partial work, not completed." } });
      process.exit(0);
    }
    if (options.kind === "partial-disconnect") {
      saveOutput(prompt, "Partial work, not completed.");
      emit({ type: "agent_message_chunk", content: { type: "text", text: "Partial work, not completed." } });
      emit({ type: "error", code: "CONNECTION_FAILED", message: "Session needs reconnect" });
      process.exit(1);
    }
    if (options.kind === "persisted") {
      if (!options.noFreshUser) saveOutput(options.wrongPrompt ? "different prompt" : prompt,
        options.text ?? "Fresh persisted answer.", options.replaceRecord ? { acpxRecordId: "replacement" } : {});
      if (options.appendOtherUser) {
        const current = record();
        current.messages.push({ User: { id: "foreign-user", content: [{ Text: "Other turn" }] } });
        writeFileSync(marker, JSON.stringify(current));
      }
      emit({ type: "done", stopReason: "end_turn" });
      if (options.errorAfterDone) emit({ type: "error", code: "CONNECTION_FAILED", message: "Actual failure after done" });
      if (options.signal) {
        process.kill(process.pid, options.signal);
        await delay(1000);
      }
      process.exit(options.exitCode ?? (options.errorAfterDone ? 1 : 0));
    }
  }
  if (prompt.includes("simulate-reconnect-auth") || prompt.includes("simulate-reconnect-answer")) {
    saveOutput(prompt, prompt.includes("simulate-reconnect-auth")
      ? "Failed to authenticate: OAuth session expired and could not be refreshed"
      : "I documented why OAuth credentials expire; the synthetic task is complete.");
    if (prompt.includes("simulate-reconnect-auth")) {
      emit({ type: "error", code: "CONNECTION_FAILED", message: "Session needs reconnect" });
      process.exit(1);
    }
    emit({ type: "done", stopReason: "end_turn" });
    process.exit(0);
  }
  emit({ type: "agent_message_chunk", content: { type: "text", text: "Synthetic turn complete." } });
  emit({ type: "done" });
  process.exit(0);
}
if (args.includes("show")) {
  if (options.missingBaseline && !existsSync(attemptsPath)) process.exit(1);
  emit(record());
} else if (args.includes("history")) {
  // ACPX 0.12.1 gives old entries the record's latest timestamp.
  emit({ entries: [{ role: "assistant", timestamp: new Date().toISOString(), textPreview: "OLD ASSISTANT OUTPUT" }] });
} else {
  await import("./fake-acpx.mjs");
}
