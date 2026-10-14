#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";

function jsonEscape(value = "") {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

function emitJson(value) {
  process.stdout.write(`${value}\n`);
}

function trimWhitespace(value) {
  return String(value).replace(/\s+/gu, " ").trim();
}

function splitText(text, size = 14) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

let cwd = process.cwd();
let agent = "";
let permissionMode = "unspecified";
const args = process.argv.slice(2);
let index = 0;

while (index < args.length) {
  const current = args[index];
  if (current === "--cwd") {
    cwd = args[index + 1] ?? process.cwd();
    index += 2;
  } else if (current === "--format") {
    index += 2;
  } else if (
    current === "--json-strict" ||
    current === "--approve-reads" ||
    current === "--approve-all" ||
    current === "--deny-all"
  ) {
    if (current !== "--json-strict") {
      permissionMode = current.slice(2);
    }
    index += 1;
  } else if (current === "--non-interactive-permissions") {
    index += 2;
  } else if (current === "--agent") {
    agent = args[index + 1] ?? "";
    index += 2;
  } else if (current.startsWith("--")) {
    break;
  } else {
    if (agent.length === 0) {
      agent = current;
      index += 1;
    }
    break;
  }
}

if (agent.length === 0) {
  agent = "unknown";
}

const command = args.slice(index);
const stateDir = join(cwd, ".fake-acpx-state");
mkdirSync(stateDir, { recursive: true });

function sessionFile(name) {
  return join(stateDir, `${basename(name)}.session`);
}

function settingFile(name, key) {
  const safeKey = String(key).replace(/[^A-Za-z0-9_.-]+/gu, "_");
  return join(stateDir, `${basename(name)}.${safeKey}.setting`);
}

function readSession(name) {
  try {
    const [status = "alive", sessionAgent = agent] = readFileSync(sessionFile(name), "utf8").split(
      /\r?\n/u
    );
    return { status, agent: sessionAgent };
  } catch {
    return null;
  }
}

function writeSession(name, status, sessionAgent) {
  writeFileSync(sessionFile(name), `${status}\n${sessionAgent}\n`, "utf8");
}

function emitError(code, message) {
  emitJson(`{"type":"error","code":"${jsonEscape(code)}","message":"${jsonEscape(message)}"}`);
}

if (command[0] === "status" && command[1] === "--session" && command[2] != null) {
  const name = command[2];
  const session = readSession(name);
  if (session == null) {
    emitJson('{"action":"status_snapshot","status":"no-session","summary":"no active session"}');
    process.exit(0);
  }
  if (name.includes("no-modes")) {
    emitJson(
      `{"status":"${jsonEscape(session.status)}","acpxRecordId":"rec-${jsonEscape(
        name
      )}","agent":"${jsonEscape(agent || session.agent)}"}`
    );
    process.exit(0);
  }
  let mode = "default";
  try {
    mode = readFileSync(settingFile(name, "mode"), "utf8").trim() || "default";
  } catch {}
  emitJson(
    `{"status":"${jsonEscape(session.status)}","acpxRecordId":"rec-${jsonEscape(
      name
    )}","acpxSessionId":"backend-${jsonEscape(name)}","agentSessionId":"agent-${jsonEscape(
    name
    )}","agent":"${jsonEscape(agent || session.agent)}","modeState":{"currentModeId":"${jsonEscape(mode)}","availableModes":[{"id":"default","name":"Default"},{"id":"plan","name":"Plan"}]}}`
  );
  process.exit(0);
}

if (
  command[0] === "set-mode" &&
  command[1] != null &&
  command[2] === "--session" &&
  command[3] != null
) {
  const mode = command[1];
  const name = command[3];
  if (readSession(name) == null) {
    emitError("NO_SESSION", "No acpx session found");
    process.exit(4);
  }
  if (name.includes("mode-switch-fail")) {
    emitError("SIM_MODE_FAIL", "Simulated mode transition failure");
    process.exit(1);
  }
  writeFileSync(settingFile(name, "mode"), `${mode}\n`, "utf8");
  emitJson(
    `{"status":"set","session":"${jsonEscape(name)}","mode":"${jsonEscape(mode)}"}`
  );
  process.exit(0);
}

if (command[0] === "sessions" && command[1] === "new") {
  let name = `session-${Date.now()}`;
  for (let commandIndex = 0; commandIndex < command.length; commandIndex += 1) {
    if (command[commandIndex] === "--name" && command[commandIndex + 1] != null) {
      name = command[commandIndex + 1];
      break;
    }
  }
  writeSession(name, "alive", agent);
  emitJson(
    `{"acpxRecordId":"rec-${jsonEscape(name)}","acpxSessionId":"backend-${jsonEscape(
      name
    )}","agentSessionId":"agent-${jsonEscape(name)}","status":"alive"}`
  );
  process.exit(0);
}

if (command[0] === "sessions" && command[1] === "close" && command[2] != null) {
  const closeFailureMarker = join(stateDir, `${basename(command[2])}.close-failed`);
  if (command[2].includes("retry-close") && !existsSync(closeFailureMarker)) {
    writeFileSync(closeFailureMarker, "failed\n", "utf8");
    emitError("SIM_CLOSE_FAIL", "Simulated first close failure");
    process.exit(1);
  }
  rmSync(sessionFile(command[2]), { force: true });
  emitJson('{"status":"closed"}');
  process.exit(0);
}

if (command[0] === "sessions" && command[1] === "show" && command[2] != null) {
  const name = command[2];
  if (readSession(name) == null) {
    emitError("NO_SESSION", "No acpx session found");
    process.exit(4);
  }
  if (name.includes("no-modes")) {
    emitJson('{"messages":[],"acpx":{}}');
    process.exit(0);
  }
  let mode = "default";
  try {
    mode = readFileSync(settingFile(name, "mode"), "utf8").trim() || "default";
  } catch {}
  emitJson(
    `{"messages":[],"acpx":{"current_mode_id":"${jsonEscape(mode)}","config_options":[{"type":"select","id":"mode","currentValue":"${jsonEscape(mode)}","options":[{"value":"default","name":"Default"},{"value":"plan","name":"Plan"}]}]}}`
  );
  process.exit(0);
}

if (command[0] === "sessions" && command[1] === "history") {
  emitJson('{"entries":[]}');
  process.exit(0);
}

if (command[0] === "cancel" && command[1] === "--session" && command[2] != null) {
  const name = command[2];
  const session = readSession(name);
  if (session != null) {
    writeSession(name, "alive", session.agent);
  }
  emitJson('{"status":"cancelled"}');
  process.exit(0);
}

if (
  command[0] === "set" &&
  command[1] != null &&
  command[2] != null &&
  command[3] === "--session" &&
  command[4] != null
) {
  const key = command[1];
  const value = command[2];
  const name = command[4];
  if (readSession(name) == null) {
    emitJson(
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32002,"message":"No acpx session found","data":{"acpxCode":"NO_SESSION","origin":"cli","sessionId":"unknown"}}}'
    );
    process.exit(4);
  }
  if (key === "model" && existsSync(join(stateDir, "reject-model-set"))) {
    emitError("SIM_MODEL_REJECT", `Simulated model rejection: unknown model ${value}`);
    process.exit(1);
  }
  if (key === "ocsl_workflow_v1" && existsSync(join(stateDir, "reject-workflow-set"))) {
    emitError("SIM_WORKFLOW_REJECT", "unknown config option ocsl_workflow_v1");
    process.exit(1);
  }
  writeFileSync(settingFile(name, key), `${value}\n`, "utf8");
  emitJson(
    `{"status":"set","session":"${jsonEscape(name)}","key":"${jsonEscape(
      key
    )}","value":"${jsonEscape(value)}"}`
  );
  process.exit(0);
}

if (command[0] === "prompt" && command[1] === "--session" && command[2] != null) {
  const name = command[2];
  const input = readFileSync(0, "utf8");
  const normalizedInput = trimWhitespace(input);
  if (readSession(name) == null) {
    emitJson(
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32002,"message":"No acpx session found","data":{"acpxCode":"NO_SESSION","origin":"cli","sessionId":"unknown"}}}'
    );
    process.exit(4);
  }
  const isForkPrompt = normalizedInput.includes("This is a fork of session");
  if (
    (normalizedInput.includes("SLOW_TURN") && !isForkPrompt) ||
    (normalizedInput.includes("SLOW_FORK_TARGET") && isForkPrompt)
  ) {
    writeFileSync(join(stateDir, `${basename(name)}.slow`), "started\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
  if (normalizedInput.includes("USAGE_CODEX_VARIANT")) {
    emitJson(
      `{"type":"usage_update","used":${normalizedInput.length},"size":4096,"usage":{"prompt_tokens":${normalizedInput.length},"completion_tokens":12,"prompt_tokens_details":{"cached_tokens":5}}}`
    );
  } else {
    emitJson(
      `{"type":"usage_update","used":${normalizedInput.length},"size":4096,"input_tokens":${normalizedInput.length},"output_tokens":12,"cache_read_input_tokens":5,"cache_creation_input_tokens":3}`
    );
  }
  let reply;
  if (normalizedInput.includes("CLAUDE_OAUTH_EXPIRED")) {
    emitError(
      "AUTHENTICATION_ERROR",
      "OAuth access token expired; run claude login again. token=must-not-survive"
    );
    process.exit(0);
  } else if (normalizedInput.includes("CLAUDE_OAUTH_INVALID_GRANT")) {
    emitError("INTERNAL_ERROR", "Failed to refresh OAuth token: invalid_grant token=must-not-survive");
    process.exit(0);
  } else if (normalizedInput.includes("CLAUDE_OAUTH_REFRESH_BUSY")) {
    emitError("INTERNAL_ERROR", "Internal error: Failed to refresh OAuth token: Another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again. token=must-not-survive");
    process.exit(0);
  } else if (normalizedInput.includes("PROVIDER_CONNECTION_FAILED")) {
    emitError("CONNECTION_FAILED", "upstream connection reset");
    process.exit(0);
  } else if (normalizedInput.includes("PROVIDER_RATE_LIMITED")) {
    emitJson('{"type":"error","code":"RATE_LIMITED","message":"rate limit exceeded","retryable":true}');
    process.exit(0);
  } else if (normalizedInput.includes("SECRET_ERROR")) {
    emitError(
      "SIM_SECRET",
      "authorization: Bearer bearer-secret at https://user:pass@example.test/path?token=query-secret OPENAI_API_KEY=sk-proj-rawsecret PUPPENCLAW_DAEMON_TOKEN=raw-token Incorrect API key provided: sk-proj-anotherraw"
    );
    process.exit(0);
  } else if (normalizedInput.includes("FAIL_TURN")) {
    emitError("SIM_FAIL", "Simulated turn failure");
    process.exit(0);
  } else if (normalizedInput.includes("PUPPENFUSION_ROLE: planning")) {
    if (normalizedInput.includes("PUPPENFUSION_CANDIDATE: codex")) {
      reply =
        "## Scope\nImplement the requested feature with minimal risk.\n## Architecture\nPrefer a direct module change.\n## Files\n- src.ts\n- codex-plan.txt\n## Validation\n- Run the configured evaluation command.\n## Risks\n- Keep scope bounded to the sealed bundle.";
    } else {
      reply =
        "## Scope\nImplement the requested feature cleanly from the sealed bundle.\n## Architecture\nFavor explicit structure and readable changes.\n## Files\n- src.ts\n- claude-plan.txt\n## Validation\n- Run the configured evaluation command.\n## Risks\n- Avoid widening scope beyond the approved plan.";
    }
  } else if (normalizedInput.includes("PUPPENFUSION_ROLE: implementation")) {
    if (normalizedInput.includes("PUPPENFUSION_CANDIDATE: codex")) {
      writeFileSync(join(cwd, "codex-candidate.txt"), "codex candidate output\n", "utf8");
      reply =
        "## Summary\nImplemented the Codex candidate.\n## Changed Areas\n- Added codex-candidate.txt\n## Decisions\n- Keep the change isolated to Codex-owned output.\n## Risks\n- Minimal.\n## Validation\n- Ready for evaluation.";
    } else {
      writeFileSync(join(cwd, "claude-candidate.txt"), "claude candidate output\n", "utf8");
      reply =
        "## Summary\nImplemented the Claude candidate.\n## Changed Areas\n- Added claude-candidate.txt\n## Decisions\n- Keep the change isolated to Claude-owned output.\n## Risks\n- Minimal.\n## Validation\n- Ready for evaluation.";
    }
  } else if (normalizedInput.includes("PUPPENFUSION_ROLE: peer_review")) {
    if (normalizedInput.includes("PUPPENFUSION_CANDIDATE: codex")) {
      reply =
        "## Verdict\nAccept with small follow-up.\n## Strengths\n- The Claude candidate is readable.\n## Weaknesses\n- The change could expose more rationale.\n## Risks\n- Low.\n## Merge Guidance\n- Keep the file-level change and preserve the bounded scope.";
    } else {
      reply =
        "## Verdict\nAccept with small follow-up.\n## Strengths\n- The Codex candidate is direct.\n## Weaknesses\n- The change could expose more rationale.\n## Risks\n- Low.\n## Merge Guidance\n- Keep the file-level change and preserve the bounded scope.";
    }
  } else if (normalizedInput.includes("PUPPENFUSION_ROLE: merge")) {
    writeFileSync(join(cwd, "merged-candidate.txt"), "resolved merged output\n", "utf8");
    reply =
      "## Summary\nResolved the fusion merge in the merged worktree.\n## Incorporated from Codex\n- Preserved the direct candidate change.\n## Incorporated from Claude\n- Preserved the readable candidate change.\n## Remaining Risks\n- Low.\n## Validation\n- Ready for evaluation.";
  } else if (normalizedInput.includes("PUPPENCLAW_REASSESSMENT")) {
    writeFileSync(join(cwd, "reassessment-fix.txt"), "conservative reassessment fix\n", "utf8");
    reply =
      "## Executive judgment\nPatched one obvious old-model mistake.\n## Imported sessions reviewed\n- Reviewed imported fixtures.\n## Findings by importance\n- functionality: missing reassessment-fix.txt was an obvious prior omission.\n## Patches made\n- Added reassessment-fix.txt.\n## Findings intentionally not patched\n- No refactor-only findings patched.\n## Validation instructions and residual risk\n- Run the configured validation command.";
  } else if (normalizedInput.includes("ASK_USER")) {
    emitJson(
      '{"sessionUpdate":"tool_call","toolCallId":"ask-user-1","title":"Localized input title","rawInput":{"questions":[{"question":"Which source should I use?"}]},"_meta":{"claudeCode":{"toolName":"AskUserQuestion"}}}'
    );
    reply = "Need input from the user?";
  } else if (normalizedInput.includes("EXIT_PLAN_MODE")) {
    emitJson(
      '{"sessionUpdate":"plan","entries":[{"content":"Search primary sources","status":"pending","priority":"high"}]}'
    );
    emitJson(
      '{"sessionUpdate":"tool_call","toolCallId":"exit-plan-1","title":"Localized plan title","_meta":{"claudeCode":{"toolName":"ExitPlanMode"}}}'
    );
    reply = "The plan is ready. Should I proceed?";
  } else if (normalizedInput.includes("SPOOF_PLAN_TITLE")) {
    emitJson('{"sessionUpdate":"tool_call","toolCallId":"spoof-plan-1","title":"ExitPlanMode"}');
    reply = "This is an ordinary answer.";
  } else if (normalizedInput.includes("REPORT_PERMISSION_MODE")) {
    reply = `Permission mode: ${permissionMode}`;
  } else if (normalizedInput.includes("REPORT_NATIVE_MODE")) {
    let nativeMode = "default";
    try {
      nativeMode = readFileSync(settingFile(name, "mode"), "utf8").trim() || "default";
    } catch {}
    reply = `Native mode: ${nativeMode}`;
  } else {
    reply = `Handled: ${normalizedInput}`;
  }
  for (const chunk of splitText(reply, 14)) {
    emitJson(
      `{"type":"agent_message_chunk","content":{"type":"text","text":"${jsonEscape(chunk)}"}}`
    );
  }
  emitJson('{"type":"done","stopReason":"end_turn"}');
  process.exit(0);
}

emitError("UNSUPPORTED", `Unsupported fake-acpx invocation: ${command.join(" ")}`);
