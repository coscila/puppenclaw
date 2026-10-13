import { describe, expect, it } from "vitest";

import { AcpPlanPermissionTracker } from "../../src/manager/acp-plan-permissions.js";

const context = {
  exitCode: 5, signal: null, interactionMode: "plan", permissionMode: "approve-reads",
  hasFreshOutput: true, hasError: false
};
const prompt = {
  jsonrpc: "2.0", id: 7, method: "session/prompt",
  params: { sessionId: "native-session", prompt: [{ type: "text", text: "Private prompt" }] }
};
const answer = {
  jsonrpc: "2.0", method: "session/update", params: {
    sessionId: "native-session", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fresh planning answer." }
    }
  }
};
const terminal = { jsonrpc: "2.0", id: 7, result: { stopReason: "end_turn" } };

function permission(id: number | string = 0) {
  return {
    jsonrpc: "2.0", id, method: "session/request_permission", params: {
      sessionId: "native-session", toolCall: {
        toolCallId: "native-tool", kind: "switch_mode", title: "Localized title is not evidence",
        rawInput: { plan: "Private plan" }
      },
      options: [
        { optionId: "default", kind: "allow_once", name: "Allow" },
        { optionId: "plan", kind: "reject_once", name: "Keep planning" }
      ]
    }
  };
}

function response(id: number | string = 0, optionId = "plan") {
  return { jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId } } };
}

function observe(messages: unknown[]) {
  const tracker = new AcpPlanPermissionTracker();
  for (const message of messages) tracker.observeLine(JSON.stringify(message));
  return tracker;
}

function completed(prefix: unknown[] = [permission(), response()]) {
  return observe([prompt, ...prefix, answer, terminal]);
}

describe("AcpPlanPermissionTracker", () => {
  it.each([0, 5])("captures only the correlated offered plan on a completed read-only handoff (exit %s)", (exitCode) => {
    const request = permission();
    Object.assign(request.params.toolCall, { content: [{ type: "content", content: { type: "text", text: "# Actual offered plan" } }] });
    const tracker = completed([request, response()]);
    expect(tracker.completedPlanHandoff({ ...context, exitCode })).toEqual({ text: "# Actual offered plan" });
    expect(JSON.stringify(tracker)).not.toContain("Actual offered plan");
    expect(tracker.allowsCompletedPlan({ ...context, exitCode })).toBe(exitCode === 5);
  });

  it.each([{ exitCode: 1 }, { hasError: true }, { interactionMode: "execute" }, { permissionMode: "approve-all" }])(
    "never turns another outcome into an approval handoff: %j", (override) => {
      expect(completed().completedPlanHandoff({ ...context, ...override })).toBeUndefined();
    },
  );

  it("accepts only a correlated completed planning turn with a declined mode switch", () => {
    const tracker = completed();
    expect(tracker.allowsCompletedPlan(context)).toBe(true);
    expect(tracker.deniedPlanRequests).toBe(1);
    expect(JSON.stringify(tracker)).not.toMatch(/Private prompt|Private plan|Fresh planning answer/);
  });

  it("accepts repeated keep-planning decisions while distinguishing numeric and string IDs", () => {
    const tracker = completed([permission(0), response(0), permission("0"), response("0")]);
    expect(tracker.allowsCompletedPlan(context)).toBe(true);
    expect(tracker.deniedPlanRequests).toBe(2);
  });

  it.each([
    { exitCode: 0 }, { exitCode: 1 }, { exitCode: null }, { signal: "SIGTERM" },
    { interactionMode: "execute" }, { interactionMode: undefined },
    { permissionMode: "deny-all" }, { permissionMode: "approve-all" },
    { hasFreshOutput: false }, { hasError: true }
  ])("does not excuse a different runtime outcome: %j", (override) => {
    const combined = { ...context, ...override };
    const { interactionMode, ...rest } = combined;
    expect(completed().allowsCompletedPlan({ ...rest,
      ...(interactionMode !== undefined ? { interactionMode } : {})
    })).toBe(false);
  });

  it.each(["read", "execute", "edit", "other"])("rejects other requested permissions: %s", (kind) => {
    const other = permission(1);
    other.params.toolCall.kind = kind;
    expect(completed([permission(), response(), other, response(1)]).allowsCompletedPlan(context)).toBe(false);
  });

  it.each(["default", "acceptEdits", "auto", "reject", "unknown"])("rejects another selected option: %s", (option) => {
    expect(completed([permission(), response(0, option)]).allowsCompletedPlan(context)).toBe(false);
  });

  it("rejects cancelled, missing, duplicate, orphaned and contradictory replies", () => {
    for (const exchanges of [
      [permission()],
      [response()],
      [permission(), response(), response()],
      [permission(), response(), { jsonrpc: "2.0", id: 0, result: {} }],
      [permission(), { jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "cancelled" } } }],
      [permission(), response(1)],
      [permission(), permission(), response()]
    ]) expect(completed(exchanges).allowsCompletedPlan(context)).toBe(false);
  });

  it("requires exactly one matched native prompt and terminal response", () => {
    for (const messages of [
      [permission(), response(), answer, terminal],
      [prompt, prompt, permission(), response(), answer, terminal],
      [prompt, permission(), response(), answer],
      [prompt, permission(), response(), answer, { ...terminal, id: 8 }],
      [prompt, permission(), response(), answer, { ...terminal, result: { stopReason: "cancelled" } }],
      [prompt, permission(), response(), answer, terminal, terminal],
      [prompt, permission(7), response(7), answer, terminal],
      [prompt, permission(), answer, terminal, response()]
    ]) expect(observe(messages).allowsCompletedPlan(context)).toBe(false);
  });

  it("rejects foreign-session permissions, output, and replayed output outside the prompt", () => {
    const foreignPermission = permission();
    foreignPermission.params.sessionId = "other-session";
    const foreignAnswer = { ...answer, params: { ...answer.params, sessionId: "other-session" } };
    for (const messages of [
      [prompt, foreignPermission, response(), answer, terminal],
      [prompt, permission(), response(), foreignAnswer, terminal],
      [answer, prompt, permission(), response(), terminal],
      [prompt, permission(), response(), terminal, answer]
    ]) expect(observe(messages).allowsCompletedPlan(context)).toBe(false);
  });

  it("requires structured assistant text, not thoughts or a caller's output claim", () => {
    const thoughts = { ...answer, params: { ...answer.params,
      update: { ...answer.params.update, sessionUpdate: "agent_thought_chunk" }
    } };
    expect(observe([prompt, permission(), response(), thoughts, terminal]).allowsCompletedPlan(context)).toBe(false);
    expect(observe([prompt, permission(), response(), terminal]).allowsCompletedPlan(context)).toBe(false);
  });

  it("ignores historical startup probe errors before the current prompt", () => {
    const tracker = observe([
      { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Resume unsupported" } },
      { jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "old-session", update: {
          sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Old answer" }
        }
      } },
      prompt, permission(), response(), answer, terminal
    ]);
    expect(tracker.allowsCompletedPlan(context)).toBe(true);
    expect(tracker.allowsCompletedPlan({ ...context, hasError: true })).toBe(false);
  });

  it("rejects pre-prompt permissions that contribute to ACPX's cumulative counters", () => {
    for (const startup of [[permission(50)], [response(50)], [permission(50), response(50)]]) {
      expect(observe([...startup, prompt, permission(), response(), answer, terminal])
        .allowsCompletedPlan(context)).toBe(false);
    }
  });

  it("rejects typed errors in the current prompt, including after terminal completion", () => {
    for (const error of [
      { type: "error", message: "Disconnected" },
      { jsonrpc: "2.0", id: 99, error: { code: -32000, message: "Failure" } }
    ]) {
      const tracker = completed();
      tracker.observe(error);
      expect(tracker.allowsCompletedPlan(context)).toBe(false);
    }
  });

  it("rejects a cancellation request even if a terminal response follows", () => {
    expect(completed([permission(), response(), {
      jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "native-session" }
    }]).allowsCompletedPlan(context)).toBe(false);
  });

  it("rejects a move to execution mode", () => {
    expect(completed([permission(), response(), { jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "native-session", update: { sessionUpdate: "current_mode_update", currentModeId: "default" }
    } }]).allowsCompletedPlan(context)).toBe(false);
  });

  it("does not trust titles, prose, wrong option kinds, or contradictory native identities", () => {
    const wrongKind = permission();
    wrongKind.params.options[1]!.kind = "allow_once";
    const duplicate = permission();
    duplicate.params.options.push({ optionId: "plan", kind: "allow_once", name: "Allow" });
    const extraRejection = permission();
    extraRejection.params.options.push({ optionId: "other", kind: "reject_once", name: "Other" });
    const badIdentity = permission();
    const tool = { ...badIdentity.params.toolCall, _meta: { claudeCode: { toolName: "AskUserQuestion" } } };
    for (const request of [wrongKind, duplicate, extraRejection,
      { ...badIdentity, params: { ...badIdentity.params, toolCall: tool } }
    ]) expect(completed([request, response()]).allowsCompletedPlan(context)).toBe(false);
  });

  it("fails closed on malformed stdout and bounded request overflow", () => {
    const tracker = completed();
    tracker.observeLine("[acpx] agent needs reconnect");
    expect(tracker.allowsCompletedPlan(context)).toBe(false);
    for (const value of [null, [], "ExitPlanMode", 5]) {
      const candidate = completed();
      candidate.observe(value);
      expect(candidate.allowsCompletedPlan(context)).toBe(false);
    }
    const many: unknown[] = [];
    for (let index = 0; index < 129; index += 1) many.push(permission(index + 100), response(index + 100));
    expect(completed(many).allowsCompletedPlan(context)).toBe(false);
  });
});
