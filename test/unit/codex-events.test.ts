import { describe, expect, it } from "vitest";

import { CodexEventAdapter } from "../../src/manager/codex-events.js";

function message(text: string, phase?: string, id = "message-1") {
  return {
    type: "item.completed",
    item: { id, type: "agent_message", text, ...(phase != null ? { phase } : {}) }
  };
}

describe("CodexEventAdapter", () => {
  it("reads the documented native agent_message.text without inventing final provenance", () => {
    const adapter = new CodexEventAdapter();
    expect(adapter.consume(message("The references are ready."))).toEqual({
      activities: [], assistantText: "The references are ready."
    });
    adapter.consume({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10 } });
    expect(adapter.terminalStatus).toBe("completed");
    expect(adapter.finalAnswer).toBeUndefined();
  });

  it("only accepts a completed explicit final_answer as a fallback candidate", () => {
    const adapter = new CodexEventAdapter();
    adapter.consume(message("I am checking citations.", "commentary", "commentary"));
    expect(adapter.finalAnswer).toBeUndefined();
    adapter.consume({
      type: "item.started", item: { id: "final", type: "agent_message", phase: "final_answer", text: "Final" }
    });
    expect(adapter.finalAnswer).toBeUndefined();
    expect(adapter.consume(message("Final report.", "final_answer", "final")).assistantText).toBe(" report.");
    expect(adapter.finalAnswer).toBe("Final report.");
  });

  it("accepts legacy completed assistant content with explicit final phase", () => {
    const adapter = new CodexEventAdapter();
    expect(adapter.consume({
      type: "response_item",
      item: { type: "message", role: "assistant", phase: "final_answer", content: [
        { type: "output_text", text: "Verified " },
        { type: "reasoning", text: "private reasoning" },
        { type: "output_text", text: "report." }
      ] }
    }).assistantText).toBe("Verified report.");
    expect(adapter.finalAnswer).toBe("Verified report.");
  });

  it("keeps legacy unphased or commentary messages as progress", () => {
    for (const phase of [undefined, "commentary"]) {
      const adapter = new CodexEventAdapter();
      expect(adapter.consume({
        type: "response_item",
        item: { type: "message", role: "assistant", phase, content: [{ type: "output_text", text: "Still working." }] }
      }).assistantText).toBe("Still working.");
      expect(adapter.finalAnswer).toBeUndefined();
    }
  });

  it("deduplicates keyed deltas and the matching completed item snapshot", () => {
    const adapter = new CodexEventAdapter();
    const delta = { type: "response.output_text.delta", item_id: "final", sequence_number: 1, delta: "Final " };
    expect(adapter.consume(delta).assistantText).toBe("Final ");
    expect(adapter.consume(delta).assistantText).toBeUndefined();
    expect(adapter.consume({ ...delta, sequence_number: 2, delta: "report." }).assistantText).toBe("report.");
    const completed = message("Final report.", "final_answer", "final");
    expect(adapter.consume(completed).assistantText).toBeUndefined();
    expect(adapter.consume(completed).assistantText).toBeUndefined();
    expect(adapter.finalAnswer).toBe("Final report.");
  });

  it("does not deduplicate legitimate repeated delta text without an event identity", () => {
    const adapter = new CodexEventAdapter();
    const delta = { type: "response.output_text.delta", item_id: "one", delta: "ha" };
    expect(adapter.consume(delta).assistantText).toBe("ha");
    expect(adapter.consume(delta).assistantText).toBe("ha");
    expect(adapter.consume(message("haha", "final_answer", "one")).assistantText).toBeUndefined();
    expect(adapter.finalAnswer).toBe("haha");
  });

  it("scopes numeric sequence IDs to their item across multiple model responses", () => {
    const adapter = new CodexEventAdapter();
    for (const item_id of ["first", "second"]) {
      expect(adapter.consume({ type: "response.output_text.delta", sequence_number: 0, item_id, delta: "Again" })
        .assistantText).toBe("Again");
    }
  });

  it("deduplicates explicit event IDs without suppressing later distinct items", () => {
    const adapter = new CodexEventAdapter();
    const first = { ...message("First", "commentary"), event_id: "event-a" };
    expect(adapter.consume(first).assistantText).toBe("First");
    expect(adapter.consume(first).assistantText).toBeUndefined();
    expect(adapter.consume({ ...message("Second", "final_answer", "second"), event_id: "event-b" })
      .assistantText).toBe("Second");
  });

  it("handles legacy content chunks and final snapshots without duplicating text", () => {
    const adapter = new CodexEventAdapter();
    expect(adapter.consume({ type: "agent_message_chunk", content: { type: "text", text: "Final " } })
      .assistantText).toBe("Final ");
    expect(adapter.consume({ type: "agent_message_chunk", content: { type: "text", text: "report." } })
      .assistantText).toBe("report.");
    expect(adapter.consume({
      type: "response_item", item: { type: "message", phase: "final_answer", content: "Final report." }
    }).assistantText).toBeUndefined();
    expect(adapter.finalAnswer).toBe("Final report.");
  });

  it("does not allow an unfinished explicit final delta to become a fallback", () => {
    const adapter = new CodexEventAdapter();
    adapter.consume({ type: "response.output_text.delta", item_id: "one", phase: "final_answer", delta: "Half a report" });
    adapter.consume({ type: "turn.completed" });
    expect(adapter.finalAnswer).toBeUndefined();
  });

  it("invalidates an earlier final candidate when subsequent work or a new turn starts", () => {
    for (const event of [
      { type: "item.started", item: { id: "tool", type: "command_execution", command: "date" } },
      message("There is one more reference to check.", "commentary", "later"),
      { type: "turn.started" }
    ]) {
      const adapter = new CodexEventAdapter();
      adapter.consume(message("Earlier final.", "final_answer"));
      expect(adapter.finalAnswer).toBe("Earlier final.");
      adapter.consume(event);
      expect(adapter.finalAnswer).toBeUndefined();
    }
  });

  it.each([
    { type: "item.completed", item: { type: "reasoning", text: "private reasoning" } },
    { type: "response.reasoning_text.delta", delta: "private reasoning" },
    { type: "response_item", item: { type: "message", role: "assistant", channel: "analysis", content: "private reasoning" } },
    { type: "response.output_text.delta", channel: "analysis", delta: "private reasoning" },
    { type: "response_item", item: { type: "message", role: "user", content: "user text" } },
    { type: "response_item", item: { type: "message", role: "system", content: "system text" } },
    { type: "unknown.delta", delta: "protocol payload" },
    { type: "item.updated", item: { type: "file_change", text: "patch payload" } },
    "malformed output token=must-not-leak",
    null
  ])("keeps non-assistant protocol payloads out of assistant output: %j", (event) => {
    const adapter = new CodexEventAdapter();
    expect(adapter.consume(event).assistantText).toBeUndefined();
    expect(adapter.finalAnswer).toBeUndefined();
  });

  it("routes native command start and completion into distinct activity records", () => {
    const adapter = new CodexEventAdapter();
    const started = { type: "item.started", item: { id: "command", type: "command_execution", command: "bash -lc date", status: "in_progress" } };
    expect(adapter.consume(started)).toEqual({ activities: [
      { type: "tool_call", title: "exec_command", text: "bash -lc date" }
    ] });
    expect(adapter.consume(started)).toEqual({ activities: [] });
    const completed = { type: "item.completed", item: {
      ...started.item, status: "completed", aggregated_output: "Tuesday", exit_code: 0
    } };
    expect(adapter.consume(completed)).toEqual({ activities: [
      { type: "tool_output", title: "exec_command", text: "Tuesday" }
    ] });
    expect(adapter.consume(completed)).toEqual({ activities: [] });
    expect(adapter.finalAnswer).toBeUndefined();
  });

  it("routes MCP tool names, arguments and results without promoting tool text", () => {
    const adapter = new CodexEventAdapter();
    const item = { id: "mcp", type: "mcp_tool_call", server: "ocsl_web", tool: "web_fetch", arguments: { url: "https://example.invalid" } };
    expect(adapter.consume({ type: "item.started", item })).toEqual({ activities: [
      { type: "tool_call", title: "ocsl_web/web_fetch", text: '{"url":"https://example.invalid"}' }
    ] });
    expect(adapter.consume({ type: "item.completed", item: { ...item, status: "completed", result: {
      content: [{ type: "text", text: "Tool body token=secret-value" }]
    } } })).toEqual({ activities: [
      { type: "tool_output", title: "ocsl_web/web_fetch", text: "Tool body token=[redacted]" }
    ] });
    expect(adapter.finalAnswer).toBeUndefined();
  });

  it("routes codex 0.147 collab_tool_call items like collab_agent_tool_call", () => {
    for (const type of ["collab_tool_call", "collab_agent_tool_call"]) {
      const adapter = new CodexEventAdapter();
      const item = { id: `spawn-${type}`, type, tool: "spawn_agent", sender_thread_id: "main", receiver_thread_ids: [], prompt: "Summarize the paper", agents_states: {}, status: "in_progress" };
      expect(adapter.consume({ type: "item.started", item })).toEqual({ activities: [
        { type: "tool_call", title: "spawn_agent" }
      ] });
      expect(adapter.consume({ type: "item.completed", item: { ...item, receiver_thread_ids: ["worker"], status: "completed" } }))
        .toEqual({ activities: [{ type: "tool_output", title: "spawn_agent" }] });
      expect(adapter.finalAnswer).toBeUndefined();
    }
  });

  it("ignores OCSL wrapper metadata lines entirely", () => {
    const adapter = new CodexEventAdapter();
    adapter.consume(message("Final report.", "final_answer"));
    adapter.consume({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } });
    for (const line of [
      { type: "ocsl.model_usage", version: 1, threads: [{ threadId: "t", parentThreadId: null, role: "main", agentRole: null, model: "m",
        usage: { input_tokens: 999, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 999, reasoning_output_tokens: 0, total_tokens: 1998 } }] },
      { type: "OCSL.model_usage", message: "assistant message text", item: { type: "agent_message", text: "leak" } },
      { type: "ocsl.future_metadata", usage: { input_tokens: 5 }, error: { message: "not an error" } }
    ]) {
      expect(adapter.consume(line)).toEqual({ activities: [] });
    }
    expect(adapter.finalAnswer).toBe("Final report.");
    expect(adapter.terminalStatus).toBe("completed");
    expect(adapter.latestUsage?.total).toBe(12);
    expect(adapter.lastError).toBeUndefined();
  });

  it("keeps legacy tool calls hidden even inside assistant message-shaped envelopes", () => {
    const adapter = new CodexEventAdapter();
    expect(adapter.consume({
      type: "response_item", item: { type: "message", role: "assistant", phase: "final_answer",
        content: "Not an assistant answer", tool_calls: [{ type: "function", function: {
          name: "exec_command", arguments: '{"cmd":"date","token":"secret-value"}'
        } }] }
    })).toEqual({ activities: [{ type: "tool_call", title: "exec_command", text: '{"cmd":"date","token":"[redacted]"}' }] });
    expect(adapter.finalAnswer).toBeUndefined();
  });

  it("preserves legacy function-call output activity and bounds its redacted tail", () => {
    const adapter = new CodexEventAdapter();
    const update = adapter.consume({ type: "response_item", item: {
      type: "function_call_output", output: "x".repeat(8_000) + " token=secret-value"
    } });
    expect(update.assistantText).toBeUndefined();
    expect(update.activities[0]?.type).toBe("tool_output");
    expect(update.activities[0]?.text).toContain("[truncated]");
    expect(update.activities[0]?.text).not.toContain("secret-value");
    expect(update.activities[0]?.text?.length).toBeLessThan(6_100);
  });

  it("tracks structured turn.failed independently of any visible text", () => {
    const adapter = new CodexEventAdapter();
    adapter.consume(message("The partial findings follow.", "commentary"));
    const update = adapter.consume({ type: "turn.failed", error: { message: "Stream failed token=secret-value" } });
    expect(update).toEqual({ activities: [], terminal: "failed", error: {
      message: "Stream failed token=[redacted]", transient: false
    } });
    expect(adapter.terminalStatus).toBe("failed");
    expect(adapter.failureMessage).toBe("Stream failed token=[redacted]");
    expect(adapter.finalAnswer).toBeUndefined();
  });

  it("does not turn error-only output into assistant prose or terminal success", () => {
    const adapter = new CodexEventAdapter();
    const update = adapter.consume({ type: "error", message: "Transport failed" });
    expect(update).toEqual({ activities: [], error: { message: "Transport failed", transient: false } });
    expect(adapter.lastError).toEqual(update.error);
    expect(adapter.terminalStatus).toBeUndefined();
    expect(adapter.finalAnswer).toBeUndefined();
  });

  it("keeps transient reconnect errors distinct from a later successful turn", () => {
    const adapter = new CodexEventAdapter();
    expect(adapter.consume({ type: "error", message: "Reconnecting... 1/5: stream disconnected before completion: timeout" })
      .error?.transient).toBe(true);
    adapter.consume(message("Recovered report.", "final_answer"));
    expect(adapter.consume({ type: "turn.completed" }).terminal).toBe("completed");
    expect(adapter.failureMessage).toBeUndefined();
    expect(adapter.finalAnswer).toBe("Recovered report.");
  });

  it("tracks native thread identity and preserves normalized partial/final usage", () => {
    const adapter = new CodexEventAdapter();
    adapter.consume({ type: "thread.started", thread_id: "native-thread" });
    expect(adapter.threadId).toBe("native-thread");
    expect(adapter.consume({ type: "token_count", info: { total_token_usage: {
      input_tokens: 100, cached_input_tokens: 60, output_tokens: 7
    } } }).usage).toEqual({ input: 40, cacheRead: 60, cacheWrite: 0, output: 7, total: 107 });
    expect(adapter.consume({ type: "turn.completed", usage: {
      input_tokens: 110, cached_input_tokens: 65, output_tokens: 10
    } }).usage).toEqual({ input: 45, cacheRead: 65, cacheWrite: 0, output: 10, total: 120 });
    adapter.consume({ type: "turn.completed", usage: {} });
    expect(adapter.latestUsage?.total).toBe(120);
  });

  it("preserves available partial usage on a structured failed turn", () => {
    const adapter = new CodexEventAdapter();
    expect(adapter.consume({ type: "turn.failed", error: { message: "Failed" }, usage: {
      input_tokens: 10, output_tokens: 2
    } }).usage?.total).toBe(12);
    expect(adapter.latestUsage?.total).toBe(12);
    expect(adapter.terminalStatus).toBe("failed");
  });

  it("redacts cumulative delta text and explicit final-answer candidates", () => {
    const adapter = new CodexEventAdapter();
    const progress = [
      adapter.consume({ type: "response.output_text.delta", item_id: "one", delta: "token=" }).assistantText,
      adapter.consume({ type: "response.output_text.delta", item_id: "one", delta: "secret-value" }).assistantText
    ].join("");
    expect(progress).toBe("token=[redacted]");
    adapter.consume(message("token=secret-value", "final_answer", "one"));
    expect(adapter.finalAnswer).toBe("token=[redacted]");
  });

  it("never treats a truncated oversized explicit message as a complete final answer", () => {
    const adapter = new CodexEventAdapter();
    const update = adapter.consume(message("x".repeat(1_048_577), "final_answer"));
    expect(update.assistantText?.length).toBe(1_048_576);
    expect(adapter.finalAnswer).toBeUndefined();
  });
});
