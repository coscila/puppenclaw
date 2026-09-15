import type { NormalizedUsage } from "../shared/types.js";
import { hasNonzeroUsage, normalizeCodexUsage } from "../shared/usage.js";
import { redactSensitiveText } from "../shared/utils.js";

type JsonRecord = Record<string, unknown>;

export type CodexActivity = {
  type: "tool_call" | "tool_output";
  title?: string;
  text?: string;
};

export type CodexEventError = { message: string; transient: boolean };

export type CodexEventUpdate = {
  activities: CodexActivity[];
  assistantText?: string;
  terminal?: "completed" | "failed";
  error?: CodexEventError;
  usage?: NormalizedUsage;
};

type MessageState = {
  raw: string;
  displayed: string;
  phase: string;
  complete: boolean;
  truncated: boolean;
};

const MAX_TRACKED_ITEMS = 4_096;
const MAX_MESSAGE_CHARS = 1_048_576;
const MAX_TOOL_OUTPUT_CHARS = 6_000;

function record(value: unknown): JsonRecord | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function kind(value: unknown): string {
  return text(value)?.trim().toLowerCase() ?? "";
}

function visibleContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(visibleContent).join("");
  const part = record(value);
  if (part == null || /reasoning|thinking|thought/iu.test(kind(part.type))) return "";
  return text(part.text) ?? text(part.output_text) ?? text(part.content) ?? "";
}

function errorMessage(value: unknown): string | undefined {
  const error = record(value);
  return text(value) ?? text(error?.message) ?? text(error?.code);
}

function boundedText(value: string, limit: number, tail = false): string {
  const clean = redactSensitiveText(value);
  if (clean.length <= limit) return clean;
  return tail ? `[truncated]\n${clean.slice(-limit)}` : `${clean.slice(0, limit)}...`;
}

function stringify(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value == null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  if (map.size > MAX_TRACKED_ITEMS) map.delete(map.keys().next().value as K);
}

/** Locate legacy message-shaped tool envelopes before accepting any prose. */
function toolRecord(value: unknown, depth = 0): JsonRecord | undefined {
  const item = record(value);
  if (item == null || depth > 5) return undefined;
  if (
    /(?:tool|function)_?call|command_execution|command_output|exec_output/iu.test(kind(item.type)) ||
    item.tool_name != null || item.function_name != null || record(item.function) != null
  ) return item;
  for (const key of ["tool_call", "function_call", "raw_item", "item", "output_item"]) {
    const nested = toolRecord(item[key], depth + 1);
    if (nested != null) return nested;
  }
  for (const key of ["tool_calls", "function_calls", "content", "output"]) {
    const entries = item[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const nested = toolRecord(entry, depth + 1);
      if (nested != null) return nested;
    }
  }
  return undefined;
}

/**
 * Per-invocation adapter for native `codex exec --json` and legacy Responses
 * envelopes. Progress, final-answer provenance and terminal state deliberately
 * remain separate: progress (including an unphased agent_message) is not proof
 * that the process produced a final answer. The caller owns exit/signal policy
 * and gives --output-last-message precedence over finalAnswer.
 */
export class CodexEventAdapter {
  finalAnswer: string | undefined;
  terminalStatus: "completed" | "failed" | undefined;
  failureMessage: string | undefined;
  lastError: CodexEventError | undefined;
  threadId: string | undefined;
  latestUsage: NormalizedUsage | undefined;

  private readonly messages = new Map<string, MessageState>();
  private readonly eventIds = new Map<string, true>();
  private readonly activitySnapshots = new Map<string, string>();
  private anonymousMessage = 0;
  private currentAnonymousKey: string | undefined;
  private finalMessageKey: string | undefined;

  consume(raw: unknown): CodexEventUpdate {
    const update: CodexEventUpdate = { activities: [] };
    const event = record(raw);
    if (event == null) return update;
    const eventType = kind(event.type);
    const sequenceScope = text(event.item_id) ?? text(record(event.item)?.id) ?? text(event.response_id);
    const eventId = text(event.event_id) ??
      (typeof event.sequence_number === "number" && sequenceScope != null
        ? `sequence:${sequenceScope}:${event.sequence_number}` : undefined);
    if (eventId != null) {
      if (this.eventIds.has(eventId)) return update;
      remember(this.eventIds, eventId, true);
    }

    if (eventType === "thread.started") this.threadId = text(event.thread_id);
    if (eventType === "turn.started" || eventType === "turn_started") {
      this.finalAnswer = undefined;
      this.finalMessageKey = undefined;
      this.terminalStatus = undefined;
      this.failureMessage = undefined;
      this.messages.clear();
      this.activitySnapshots.clear();
      this.currentAnonymousKey = undefined;
      return update;
    }
    const completed = eventType === "turn.completed" || eventType === "turn_completed";
    const failed = eventType === "turn.failed" || eventType === "turn_failed" ||
      eventType === "response.failed";
    const usageRaw = completed || failed ? event.usage : eventType === "token_count"
      ? record(event.info)?.total_token_usage ?? record(event.info)?.last_token_usage
      : undefined;
    if (record(usageRaw) != null) {
      const usage = normalizeCodexUsage(usageRaw);
      if (hasNonzeroUsage(usage)) update.usage = this.latestUsage = usage;
    }
    if (completed || failed) {
      update.terminal = this.terminalStatus = failed ? "failed" : "completed";
      if (failed) {
        this.failureMessage = boundedText(
          errorMessage(event.error) ?? errorMessage(record(event.response)?.error) ??
          text(event.message) ?? "Codex reported a failed turn.", MAX_TOOL_OUTPUT_CHARS
        );
        update.error = this.lastError = { message: this.failureMessage, transient: false };
      } else {
        this.failureMessage = undefined;
      }
      return update;
    }

    const subject = record(event.item) ?? record(event.output_item) ?? record(event.content) ?? event;
    const subjectType = kind(subject.type);
    if (eventType === "error" || subjectType === "error") {
      const message = boundedText(
        errorMessage(event.error) ?? text(event.message) ?? text(subject.message) ??
        "Codex reported an error.", MAX_TOOL_OUTPUT_CHARS
      );
      const transient = event.will_retry === true ||
        (/reconnecting\.\.\.\s+\d+\/\d+/iu.test(message) &&
          /stream disconnected before completion|operation was aborted due to timeout|timeout/iu.test(message));
      update.error = this.lastError = { message, transient };
      return update;
    }
    if (/reasoning|thinking|thought/iu.test(`${eventType} ${subjectType}`)) return update;
    const channel = kind(subject.channel) || kind(event.channel);
    const messagePhase = kind(subject.phase) || kind(event.phase);
    if (/^(?:analysis|reasoning|thinking|thought)$/u.test(channel) ||
      /^(?:analysis|reasoning|thinking|thought)$/u.test(messagePhase)) return update;

    const tool = toolRecord(subject) ?? toolRecord(event);
    if (tool != null) {
      this.finalAnswer = undefined;
      this.finalMessageKey = undefined;
      const activity = this.activity(event, subject, tool);
      if (activity != null) update.activities.push(activity);
      this.currentAnonymousKey = undefined;
      return update;
    }
    // Other structured work items are not assistant messages even if their
    // payload happens to have text/delta fields.
    if (/file_change|web_search|todo_list|plan_update/iu.test(subjectType)) return update;
    const role = kind(subject.role);
    if (role.length > 0 && role !== "assistant") return update;
    const assistant = role === "assistant" || subjectType === "message" ||
      /assistant|agent_message|output_text|(?:^|\.)message(?:\.|$)/iu.test(`${eventType} ${subjectType}`);
    if (!assistant) return update;

    const isDelta = /(?:delta|chunk)$/iu.test(eventType);
    const rawText = isDelta
      ? text(event.delta) ?? text(record(event.delta)?.text) ?? text(event.text) ??
        text(subject.text) ?? visibleContent(subject.content)
      : text(subject.text) ?? text(subject.output_text) ?? visibleContent(subject.content);
    if (rawText == null || rawText.length === 0) return update;

    const explicitId = text(subject.id) ?? text(event.item_id) ?? text(event.output_item_id) ?? text(event.message_id);
    const key = explicitId ?? this.currentAnonymousKey ?? `anonymous:${this.anonymousMessage++}`;
    if (explicitId == null) this.currentAnonymousKey = key;
    const previous = this.messages.get(key);
    if (previous?.complete === true) return update;
    if (this.finalMessageKey != null && this.finalMessageKey !== key) {
      this.finalAnswer = undefined;
      this.finalMessageKey = undefined;
    }
    const combined = isDelta ? (previous?.raw ?? "") + rawText : rawText;
    const truncated = combined.length > MAX_MESSAGE_CHARS || previous?.truncated === true;
    const messageRaw = combined.slice(0, MAX_MESSAGE_CHARS);
    const displayed = redactSensitiveText(messageRaw);
    const previousDisplayed = previous?.displayed ?? "";
    const visible = displayed.startsWith(previousDisplayed)
      ? displayed.slice(previousDisplayed.length)
      : displayed === previousDisplayed ? "" : `\n${displayed}`;
    const phase = messagePhase || previous?.phase || "";
    const complete = !isDelta && (
      /(?:completed|done)$/iu.test(eventType) || eventType === "response_item" ||
      eventType === "agent_message" || eventType === "message"
    );
    remember(this.messages, key, { raw: messageRaw, displayed, phase, complete, truncated });
    if (complete && explicitId == null) this.currentAnonymousKey = undefined;
    if (complete && phase === "final_answer" && !truncated && displayed.trim().length > 0) {
      this.finalAnswer = displayed.trim();
      this.finalMessageKey = key;
    }
    if (visible.length > 0) update.assistantText = visible;
    return update;
  }

  private activity(event: JsonRecord, subject: JsonRecord, tool: JsonRecord): CodexActivity | undefined {
    const eventType = kind(event.type);
    const toolType = kind(tool.type);
    const completed = /(?:completed|done)$/iu.test(eventType) ||
      /^(?:completed|failed)$/u.test(kind(tool.status));
    const isOutput = /(?:tool|function)_?(?:call_)?output|command_output|exec_output/iu.test(toolType) ||
      (completed && /command_execution|mcp_tool_call|collab_agent_tool_call/iu.test(toolType));
    const fn = record(tool.function);
    const title = toolType === "command_execution" ? "exec_command" :
      text(tool.tool) != null ? [text(tool.server), text(tool.tool)].filter(Boolean).join("/") :
      text(tool.name) ?? text(tool.tool_name) ?? text(tool.function_name) ?? text(fn?.name);
    const rawOutput = text(tool.aggregated_output) ?? text(tool.output) ?? text(tool.result) ??
      (visibleContent(record(tool.result)?.content) || undefined);
    const value = isOutput
      ? rawOutput ?? errorMessage(tool.error) ?? text(subject.output) ?? visibleContent(subject.content)
      : text(tool.command) ?? stringify(tool.arguments ?? tool.args ?? tool.input ?? fn?.arguments ?? fn?.args);
    const activity: CodexActivity = {
      type: isOutput ? "tool_output" : "tool_call",
      ...(title != null ? { title: boundedText(title, 280) } : isOutput ? {} : { title: "tool" }),
      ...(value != null && value.length > 0
        ? { text: boundedText(isOutput ? value : value.replace(/\s+/gu, " ").trim(),
          isOutput ? MAX_TOOL_OUTPUT_CHARS : 280, isOutput) }
        : {})
    };
    const id = text(tool.id) ?? text(subject.id) ?? text(event.item_id) ?? text(tool.call_id);
    if (id != null) {
      const key = `${id}:${activity.type}`;
      const signature = JSON.stringify(activity);
      if (this.activitySnapshots.get(key) === signature) return undefined;
      remember(this.activitySnapshots, key, signature);
    }
    return activity;
  }
}
