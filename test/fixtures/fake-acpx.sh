#!/usr/bin/env bash

set -euo pipefail

json_escape() {
  local value="${1-}"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf '%s' "$value"
}

emit_json() {
  printf '%s\n' "$1"
}

trim_whitespace() {
  printf '%s' "$1" | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

split_text() {
  local text="$1"
  local size="${2:-14}"
  while [[ -n "$text" ]]; do
    printf '%s\n' "${text:0:size}"
    text="${text:size}"
  done
}

cwd="$(pwd)"
agent=""
permission_mode="unspecified"
args=("$@")
index=0

while [[ $index -lt ${#args[@]} ]]; do
  current="${args[$index]}"
  case "$current" in
    --cwd)
      index=$((index + 1))
      cwd="${args[$index]:-$(pwd)}"
      index=$((index + 1))
      ;;
    --format)
      index=$((index + 2))
      ;;
    --json-strict|--approve-reads|--approve-all|--deny-all)
      if [[ "$current" != "--json-strict" ]]; then
        permission_mode="${current#--}"
      fi
      index=$((index + 1))
      ;;
    --non-interactive-permissions)
      index=$((index + 2))
      ;;
    --agent)
      index=$((index + 1))
      agent="${args[$index]:-}"
      index=$((index + 1))
      ;;
    --*)
      break
      ;;
    *)
      if [[ -z "$agent" ]]; then
        agent="$current"
        index=$((index + 1))
      fi
      break
      ;;
  esac
done

if [[ -z "$agent" ]]; then
  agent="unknown"
fi

command=("${args[@]:$index}")
state_dir="$cwd/.fake-acpx-state"
mkdir -p "$state_dir"

session_file() {
  printf '%s/%s.session' "$state_dir" "$1"
}

setting_file() {
  local name="$1"
  local key="$2"
  key="${key//[^a-zA-Z0-9_.-]/_}"
  printf '%s/%s.%s.setting' "$state_dir" "$name" "$key"
}

session_exists() {
  [[ -f "$(session_file "$1")" ]]
}

read_session_status() {
  sed -n '1p' "$(session_file "$1")"
}

read_session_agent() {
  sed -n '2p' "$(session_file "$1")"
}

write_session() {
  local name="$1"
  local status="$2"
  local session_agent="$3"
  printf '%s\n%s\n' "$status" "$session_agent" > "$(session_file "$name")"
}

emit_error() {
  local code="$1"
  local message="$2"
  emit_json "{\"type\":\"error\",\"code\":\"$(json_escape "$code")\",\"message\":\"$(json_escape "$message")\"}"
}

if [[ "${command[0]:-}" == "status" && "${command[1]:-}" == "--session" && -n "${command[2]:-}" ]]; then
  name="${command[2]}"
  if ! session_exists "$name"; then
    emit_json '{"action":"status_snapshot","status":"no-session","summary":"no active session"}'
    exit 0
  fi
  status="$(read_session_status "$name")"
  if [[ "$name" == *"no-modes"* ]]; then
    emit_json "{\"status\":\"$(json_escape "${status:-alive}")\",\"acpxRecordId\":\"rec-$(json_escape "$name")\",\"agent\":\"$(json_escape "${agent:-$(read_session_agent "$name")}")\"}"
    exit 0
  fi
  mode="default"
  if [[ -f "$(setting_file "$name" mode)" ]]; then
    mode="$(sed -n '1p' "$(setting_file "$name" mode)")"
  fi
  emit_json "{\"status\":\"$(json_escape "${status:-alive}")\",\"acpxRecordId\":\"rec-$(json_escape "$name")\",\"acpxSessionId\":\"backend-$(json_escape "$name")\",\"agentSessionId\":\"agent-$(json_escape "$name")\",\"agent\":\"$(json_escape "${agent:-$(read_session_agent "$name")}")\",\"modeState\":{\"currentModeId\":\"$(json_escape "$mode")\",\"availableModes\":[{\"id\":\"default\",\"name\":\"Default\"},{\"id\":\"plan\",\"name\":\"Plan\"}]}}"
  exit 0
fi

if [[ "${command[0]:-}" == "set-mode" && -n "${command[1]:-}" && "${command[2]:-}" == "--session" && -n "${command[3]:-}" ]]; then
  mode="${command[1]}"
  name="${command[3]}"
  if ! session_exists "$name"; then
    emit_error "NO_SESSION" "No acpx session found"
    exit 4
  fi
  if [[ "$name" == *"mode-switch-fail"* ]]; then
    emit_error "SIM_MODE_FAIL" "Simulated mode transition failure"
    exit 1
  fi
  printf '%s\n' "$mode" > "$(setting_file "$name" mode)"
  emit_json "{\"status\":\"set\",\"session\":\"$(json_escape "$name")\",\"mode\":\"$(json_escape "$mode")\"}"
  exit 0
fi

if [[ "${command[0]:-}" == "sessions" && "${command[1]:-}" == "new" ]]; then
  name="session-$(date +%s)"
  if [[ "${#command[@]}" -ge 4 ]]; then
    for (( command_index=0; command_index<${#command[@]}; command_index++ )); do
      if [[ "${command[$command_index]}" == "--name" && -n "${command[$((command_index + 1))]:-}" ]]; then
        name="${command[$((command_index + 1))]}"
        break
      fi
    done
  fi
  write_session "$name" "alive" "$agent"
  emit_json "{\"acpxRecordId\":\"rec-$(json_escape "$name")\",\"acpxSessionId\":\"backend-$(json_escape "$name")\",\"agentSessionId\":\"agent-$(json_escape "$name")\",\"status\":\"alive\"}"
  exit 0
fi

if [[ "${command[0]:-}" == "sessions" && "${command[1]:-}" == "close" && -n "${command[2]:-}" ]]; then
  if [[ "${command[2]}" == *"retry-close"* && ! -f "$state_dir/$(basename "${command[2]}").close-failed" ]]; then
    : > "$state_dir/$(basename "${command[2]}").close-failed"
    emit_error "SIM_CLOSE_FAIL" "Simulated first close failure"
    exit 1
  fi
  rm -f "$(session_file "${command[2]}")"
  emit_json '{"status":"closed"}'
  exit 0
fi

if [[ "${command[0]:-}" == "sessions" && "${command[1]:-}" == "show" && -n "${command[2]:-}" ]]; then
  name="${command[2]}"
  if ! session_exists "$name"; then
    emit_error "NO_SESSION" "No acpx session found"
    exit 4
  fi
  if [[ "$name" == *"no-modes"* ]]; then
    emit_json '{"messages":[],"acpx":{}}'
    exit 0
  fi
  mode="default"
  if [[ -f "$(setting_file "$name" mode)" ]]; then
    mode="$(sed -n '1p' "$(setting_file "$name" mode)")"
  fi
  emit_json "{\"messages\":[],\"acpx\":{\"current_mode_id\":\"$(json_escape "$mode")\",\"config_options\":[{\"type\":\"select\",\"id\":\"mode\",\"currentValue\":\"$(json_escape "$mode")\",\"options\":[{\"value\":\"default\",\"name\":\"Default\"},{\"value\":\"plan\",\"name\":\"Plan\"}]}]}}"
  exit 0
fi

if [[ "${command[0]:-}" == "sessions" && "${command[1]:-}" == "history" ]]; then
  emit_json '{"entries":[]}'
  exit 0
fi

if [[ "${command[0]:-}" == "cancel" && "${command[1]:-}" == "--session" && -n "${command[2]:-}" ]]; then
  name="${command[2]}"
  if session_exists "$name"; then
    write_session "$name" "alive" "$(read_session_agent "$name")"
  fi
  emit_json '{"status":"cancelled"}'
  exit 0
fi

if [[ "${command[0]:-}" == "set" && -n "${command[1]:-}" && -n "${command[2]:-}" && "${command[3]:-}" == "--session" && -n "${command[4]:-}" ]]; then
  key="${command[1]}"
  value="${command[2]}"
  name="${command[4]}"
  if ! session_exists "$name"; then
    emit_json '{"jsonrpc":"2.0","id":null,"error":{"code":-32002,"message":"No acpx session found","data":{"acpxCode":"NO_SESSION","origin":"cli","sessionId":"unknown"}}}'
    exit 4
  fi
  if [[ "$key" == "model" && -f "$state_dir/reject-model-set" ]]; then
    emit_error "SIM_MODEL_REJECT" "Simulated model rejection: unknown model $value"
    exit 1
  fi
  if [[ "$key" == "ocsl_workflow_v1" && -f "$state_dir/reject-workflow-set" ]]; then
    emit_error "SIM_WORKFLOW_REJECT" "unknown config option ocsl_workflow_v1"
    exit 1
  fi
  printf '%s\n' "$value" > "$(setting_file "$name" "$key")"
  emit_json "{\"status\":\"set\",\"session\":\"$(json_escape "$name")\",\"key\":\"$(json_escape "$key")\",\"value\":\"$(json_escape "$value")\"}"
  exit 0
fi

if [[ "${command[0]:-}" == "prompt" && "${command[1]:-}" == "--session" && -n "${command[2]:-}" ]]; then
  name="${command[2]}"
  input="$(cat)"
  normalized_input="$(trim_whitespace "$input")"
  if ! session_exists "$name"; then
    emit_json "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32002,\"message\":\"No acpx session found\",\"data\":{\"acpxCode\":\"NO_SESSION\",\"origin\":\"cli\",\"sessionId\":\"unknown\"}}}"
    exit 4
  fi
  if [[ ( "$normalized_input" == *"SLOW_TURN"* && "$normalized_input" != *"This is a fork of session"* ) || ( "$normalized_input" == *"SLOW_FORK_TARGET"* && "$normalized_input" == *"This is a fork of session"* ) ]]; then
    : > "$state_dir/$(basename "$name").slow"
    sleep 60
  fi
  if [[ "$normalized_input" == *"USAGE_CODEX_VARIANT"* ]]; then
    emit_json "{\"type\":\"usage_update\",\"used\":${#normalized_input},\"size\":4096,\"usage\":{\"prompt_tokens\":${#normalized_input},\"completion_tokens\":12,\"prompt_tokens_details\":{\"cached_tokens\":5}}}"
  else
    emit_json "{\"type\":\"usage_update\",\"used\":${#normalized_input},\"size\":4096,\"input_tokens\":${#normalized_input},\"output_tokens\":12,\"cache_read_input_tokens\":5,\"cache_creation_input_tokens\":3}"
  fi
  if [[ "$normalized_input" == *"CLAUDE_OAUTH_EXPIRED"* ]]; then
    emit_error "AUTHENTICATION_ERROR" "OAuth access token expired; run claude login again. token=must-not-survive"
    exit 0
  elif [[ "$normalized_input" == *"CLAUDE_OAUTH_INVALID_GRANT"* ]]; then
    emit_error "INTERNAL_ERROR" "Failed to refresh OAuth token: invalid_grant token=must-not-survive"
    exit 0
  elif [[ "$normalized_input" == *"CLAUDE_OAUTH_REFRESH_BUSY"* ]]; then
    emit_error "INTERNAL_ERROR" "Internal error: Failed to refresh OAuth token: Another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again. token=must-not-survive"
    exit 0
  elif [[ "$normalized_input" == *"PROVIDER_CONNECTION_FAILED"* ]]; then
    emit_error "CONNECTION_FAILED" "upstream connection reset"
    exit 0
  elif [[ "$normalized_input" == *"PROVIDER_RATE_LIMITED"* ]]; then
    emit_json '{"type":"error","code":"RATE_LIMITED","message":"rate limit exceeded","retryable":true}'
    exit 0
  elif [[ "$normalized_input" == *"SECRET_ERROR"* ]]; then
    emit_error "SIM_SECRET" "authorization: Bearer bearer-secret at https://user:pass@example.test/path?token=query-secret OPENAI_API_KEY=sk-proj-rawsecret PUPPENCLAW_DAEMON_TOKEN=raw-token Incorrect API key provided: sk-proj-anotherraw"
    exit 0
  elif [[ "$normalized_input" == *"FAIL_TURN"* ]]; then
    emit_error "SIM_FAIL" "Simulated turn failure"
    exit 0
  fi
  if [[ "$normalized_input" == *"PUPPENFUSION_ROLE: planning"* ]]; then
    if [[ "$normalized_input" == *"PUPPENFUSION_CANDIDATE: codex"* ]]; then
      reply=$'## Scope\nImplement the requested feature with minimal risk.\n## Architecture\nPrefer a direct module change.\n## Files\n- src.ts\n- codex-plan.txt\n## Validation\n- Run the configured evaluation command.\n## Risks\n- Keep scope bounded to the sealed bundle.'
    else
      reply=$'## Scope\nImplement the requested feature cleanly from the sealed bundle.\n## Architecture\nFavor explicit structure and readable changes.\n## Files\n- src.ts\n- claude-plan.txt\n## Validation\n- Run the configured evaluation command.\n## Risks\n- Avoid widening scope beyond the approved plan.'
    fi
  elif [[ "$normalized_input" == *"PUPPENFUSION_ROLE: implementation"* ]]; then
    if [[ "$normalized_input" == *"PUPPENFUSION_CANDIDATE: codex"* ]]; then
      printf '%s\n' 'codex candidate output' > "$cwd/codex-candidate.txt"
      reply=$'## Summary\nImplemented the Codex candidate.\n## Changed Areas\n- Added codex-candidate.txt\n## Decisions\n- Keep the change isolated to Codex-owned output.\n## Risks\n- Minimal.\n## Validation\n- Ready for evaluation.'
    else
      printf '%s\n' 'claude candidate output' > "$cwd/claude-candidate.txt"
      reply=$'## Summary\nImplemented the Claude candidate.\n## Changed Areas\n- Added claude-candidate.txt\n## Decisions\n- Keep the change isolated to Claude-owned output.\n## Risks\n- Minimal.\n## Validation\n- Ready for evaluation.'
    fi
  elif [[ "$normalized_input" == *"PUPPENFUSION_ROLE: peer_review"* ]]; then
    if [[ "$normalized_input" == *"PUPPENFUSION_CANDIDATE: codex"* ]]; then
      reply=$'## Verdict\nAccept with small follow-up.\n## Strengths\n- The Claude candidate is readable.\n## Weaknesses\n- The change could expose more rationale.\n## Risks\n- Low.\n## Merge Guidance\n- Keep the file-level change and preserve the bounded scope.'
    else
      reply=$'## Verdict\nAccept with small follow-up.\n## Strengths\n- The Codex candidate is direct.\n## Weaknesses\n- The change could expose more rationale.\n## Risks\n- Low.\n## Merge Guidance\n- Keep the file-level change and preserve the bounded scope.'
    fi
  elif [[ "$normalized_input" == *"PUPPENFUSION_ROLE: merge"* ]]; then
    printf '%s\n' 'resolved merged output' > "$cwd/merged-candidate.txt"
    reply=$'## Summary\nResolved the fusion merge in the merged worktree.\n## Incorporated from Codex\n- Preserved the direct candidate change.\n## Incorporated from Claude\n- Preserved the readable candidate change.\n## Remaining Risks\n- Low.\n## Validation\n- Ready for evaluation.'
  elif [[ "$normalized_input" == *"PUPPENCLAW_REASSESSMENT"* ]]; then
    printf '%s\n' 'conservative reassessment fix' > "$cwd/reassessment-fix.txt"
    reply=$'## Executive judgment\nPatched one obvious old-model mistake.\n## Imported sessions reviewed\n- Reviewed imported fixtures.\n## Findings by importance\n- functionality: missing reassessment-fix.txt was an obvious prior omission.\n## Patches made\n- Added reassessment-fix.txt.\n## Findings intentionally not patched\n- No refactor-only findings patched.\n## Validation instructions and residual risk\n- Run the configured validation command.'
  elif [[ "$normalized_input" == *"ASK_USER"* ]]; then
    emit_json '{"sessionUpdate":"tool_call","toolCallId":"ask-user-1","title":"Localized input title","rawInput":{"questions":[{"question":"Which source should I use?"}]},"_meta":{"claudeCode":{"toolName":"AskUserQuestion"}}}'
    reply="Need input from the user?"
  elif [[ "$normalized_input" == *"EXIT_PLAN_MODE"* ]]; then
    emit_json '{"sessionUpdate":"plan","entries":[{"content":"Search primary sources","status":"pending","priority":"high"}]}'
    emit_json '{"sessionUpdate":"tool_call","toolCallId":"exit-plan-1","title":"Localized plan title","_meta":{"claudeCode":{"toolName":"ExitPlanMode"}}}'
    reply="The plan is ready. Should I proceed?"
  elif [[ "$normalized_input" == *"SPOOF_PLAN_TITLE"* ]]; then
    emit_json '{"sessionUpdate":"tool_call","toolCallId":"spoof-plan-1","title":"ExitPlanMode"}'
    reply="This is an ordinary answer."
  elif [[ "$normalized_input" == *"REPORT_PERMISSION_MODE"* ]]; then
    reply="Permission mode: $permission_mode"
  elif [[ "$normalized_input" == *"REPORT_NATIVE_MODE"* ]]; then
    native_mode="default"
    if [[ -f "$(setting_file "$name" mode)" ]]; then
      native_mode="$(sed -n '1p' "$(setting_file "$name" mode)")"
    fi
    reply="Native mode: $native_mode"
  else
    reply="Handled: $normalized_input"
  fi
  while IFS= read -r chunk; do
    emit_json "{\"type\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"$(json_escape "$chunk")\"}}"
  done < <(split_text "$reply" 14)
  emit_json '{"type":"done","stopReason":"end_turn"}'
  exit 0
fi

emit_error "UNSUPPORTED" "Unsupported fake-acpx invocation: ${command[*]}"
