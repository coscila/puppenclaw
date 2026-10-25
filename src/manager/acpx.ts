import type { AdvancedRuntime } from "../advanced/runtime.js";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionStore } from "../shared/store.js";
import { requiresFreshClaudeTranscript } from "../shared/model-compatibility.js";
import { UsageLedgerStore } from "../shared/usage-ledger.js";
import type { TurnStatisticsRecorder } from "../statistics/recorder.js";
import { hasNonzeroUsage, normalizeUsage } from "../shared/usage.js";
import {
  normalizeModelUsageGroup,
  OCSL_MODEL_USAGE_TYPE,
  parseOcslModelUsage,
  sumNormalizedUsage,
  type ModelUsageGroup,
  type ModelUsageRole
} from "../shared/model-usage.js";
import { DEFAULT_MAX_SESSIONS } from "../shared/schema.js";
import { ensureError, PuppenclawError } from "../shared/errors.js";
import type { PluginLogger } from "../shared/logger.js";
import type { OutputRouter } from "../shared/output-router.js";
import { killProcessTree, killProcessTreeWithEscalation } from "../shared/process-tree.js";
import { classifyProviderFailure, type ProviderFailure } from "../shared/provider-failures.js";
import {
  acceptedReasoningModes,
  reasoningProfileFor,
  resolveReasoningMode
} from "../shared/reasoning.js";
import { jsonToolResult, textToolResult } from "../shared/tool-results.js";
import {
  fingerprintSendRequest,
  fingerprintStartRequest
} from "../shared/turn-idempotency.js";
import type {
  ActiveTurnLifecycleState,
  ActiveTurnMetadata,
  AgentKind,
  CostParams,
  EffortLevel,
  FocusParams,
  ForkParams,
  InteractionMode,
  ModelProviderConfig,
  NativePlanEntry,
  NormalizedUsage,
  ParsedPluginConfig,
  PermissionMode,
  PlanningProfile,
  PromptEvent,
  QuiesceParams,
  QuiescenceReleaseParams,
  ResumeParams,
  SendParams,
  SessionInfo,
  SessionRecoveryFence,
  SessionTranscriptEntry,
  StartParams,
  StatusParams,
  StopParams,
  SuspendParams,
  ToolResult,
  TokenUsage,
  TurnRequestErrorOutcome,
  TurnRequestReceipt,
  TurnRequestSuccessOutcome,
  TurnOutputRole,
  UsageLedgerEntry,
  TurnSignals,
  UnfocusParams
} from "../shared/types.js";
import {
  loadContextFiles,
  nowIso,
  redactSensitiveText
} from "../shared/utils.js";
import type { ISessionManager } from "./interface.js";
import type { RunnerRegistry } from "./runner-registry.js";
import { CodexEventAdapter, isWrapperMetadataType } from "./codex-events.js";
import { AcpPlanPermissionTracker } from "./acp-plan-permissions.js";
import { TurnDiagnosticsRecorder, purgeSessionDiagnostics, readCodexFinalMessageFile, unlinkCodexFinalMessageFile } from "./turn-diagnostics.js";

type JsonRecord = Record<string, unknown>;

type ControlCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

type RuntimeStatus = {
  exists: boolean;
  status?: string;
  raw?: JsonRecord | null;
};

type NativeModePreparation = {
  activeMode?: string;
  restoreMode?: string;
  warning?: string;
};

type TurnModelUsage = {
  /** The runner turn id shared by every per-model ledger row of this turn. */
  turnId: string;
  /**
   * The session pinned its subagents to local model workers
   * (`modelProvider.subagents`), so subagent entries ran on the local model,
   * not on the session provider.
   */
  localWorkers: boolean;
  entries: Array<{
    role: ModelUsageRole;
    model: string;
    threads: number;
    usage: NormalizedUsage;
  }>;
};

type TurnResult = {
  output: string;
  outputRole?: TurnOutputRole;
  question?: string;
  tokenUsage?: TokenUsage;
  /** With `modelUsage` this is the sum over its entries (never added to Codex usage). */
  usage?: NormalizedUsage;
  /** Per-(role, model) usage from the OCSL wrapper's `ocsl.model_usage` line. */
  modelUsage?: TurnModelUsage;
  stopReason?: string;
  durationMs?: number;
  warnings: string[];
  transcript: SessionTranscriptEntry[];
  state: SessionInfo["state"];
  signals?: TurnSignals;
  failureCode?: string;
  retryable?: boolean;
};

function normalizeProviderError(session: Pick<SessionInfo, "agent">, error: unknown): Error {
  if (
    error instanceof PuppenclawError &&
    (error.code === "PROVIDER_AUTHENTICATION_REQUIRED" ||
      error.code === "PROVIDER_CONNECTION_FAILED" ||
      error.code === "PROVIDER_AUTHENTICATION_BUSY" ||
      error.code === "PROVIDER_PAUSED")
  ) {
    return error;
  }
  const source = ensureError(error);
  const code =
    error instanceof PuppenclawError
      ? error.code
      : typeof (error as NodeJS.ErrnoException | null)?.code === "string"
        ? (error as NodeJS.ErrnoException).code
        : undefined;
  const failure = classifyProviderFailure({
    agent: session.agent,
    ...(code != null ? { code } : {}),
    message: source.message,
    ...(error instanceof PuppenclawError && typeof error.details?.retryable === "boolean"
      ? { retryable: error.details.retryable }
      : {})
  });
  return failure == null
    ? source
    : new PuppenclawError(failure.code, failure.message, { retryable: failure.retryable });
}

function failedProviderTurn(failure: ProviderFailure): TurnResult {
  return {
    output: failure.message,
    warnings: [],
    transcript: [{ role: "status", text: failure.message, createdAt: nowIso() }],
    state: "failed",
    failureCode: failure.code,
    retryable: failure.retryable
  };
}

function outputRoleForTurn(turn: TurnResult): TurnOutputRole {
  return turn.outputRole ?? (turn.state === "failed" ? "status" : "assistant");
}

function withTurnReceipt(
  result: ToolResult,
  turnKey: string,
  state: "accepted" | "replayed"
): ToolResult {
  return {
    ...result,
    details: {
      ...result.details,
      turnReceipt: { turnKey, state }
    }
  };
}

function toolResultFromTurnOutcome(
  outcome: TurnRequestSuccessOutcome,
  turnKey: string,
  receiptState: "accepted" | "replayed"
): ToolResult {
  return withTurnReceipt(
    textToolResult(outcome.summary, {
      session: outcome.session,
      output: outcome.output,
      outputRole: outcome.outputRole,
      ...(outcome.failureCode != null ? { failureCode: outcome.failureCode } : {}),
      ...(outcome.retryable != null ? { retryable: outcome.retryable } : {}),
      ...(outcome.turnSignals != null ? { turnSignals: outcome.turnSignals } : {}),
      contextFiles: outcome.contextFiles,
      ...(outcome.skills != null ? { skills: outcome.skills } : {})
    }),
    turnKey,
    receiptState
  );
}

function durableTurnError(error: unknown): TurnRequestErrorOutcome {
  const source = ensureError(error);
  const details: Record<string, string | number | boolean | null> = {};
  if (error instanceof PuppenclawError && error.details != null) {
    for (const [key, value] of Object.entries(error.details)) {
      if (/(?:auth|credential|password|provider|secret|token|url)/iu.test(key)) {
        continue;
      }
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        details[key] = typeof value === "string" ? sanitizeActiveTurnText(value) : value;
      }
    }
  }
  return {
    version: 1,
    kind: "error",
    code: error instanceof PuppenclawError ? error.code : "TURN_EXECUTION_FAILED",
    message: sanitizeActiveTurnText(source.message),
    ...(error instanceof PuppenclawError && typeof error.details?.retryable === "boolean"
      ? { retryable: error.details.retryable }
      : {}),
    ...(Object.keys(details).length > 0 ? { details } : {})
  };
}

function throwDurableTurnError(
  outcome: TurnRequestErrorOutcome,
  turnKey: string,
  state: "accepted" | "replayed"
): never {
  throw new PuppenclawError(outcome.code, outcome.message, {
    ...outcome.details,
    ...(outcome.retryable != null ? { retryable: outcome.retryable } : {}),
    turnReceipt: { turnKey, state }
  });
}

type ActiveTurnOutput = {
  sessionName: string;
  text: string;
  startedAt: string;
  updatedAt: string;
  complete: boolean;
  totalChars: number;
};

type ActiveTurnProcess = {
  child: ChildProcess;
  turnId: string;
};

type ActiveTurnRuntimeStatus = {
  classification:
    | "inactive"
    | "starting"
    | "running"
    | "completed"
    | "failed"
    | "stopped"
    | "orphaned";
  lockHeld: boolean;
  trackedChild: boolean;
  processAlive: boolean | null;
  identityMatches: boolean | null;
  pid: number | null;
  processGroupId: number | null;
  startedAt: string | null;
  updatedAt: string | null;
  lastOutputAt: string | null;
  outputChars: number;
  ageMs: number | null;
  outputAgeMs: number | null;
  conflict: string | null;
};

type SpawnCommand = {
  command: string;
  args: string[];
  shell: boolean;
};

type InstalledSkill = {
  name: string;
  sourcePath: string;
  targetPath: string;
};

type KeyedTurnExecution = {
  turnKey: string;
  requestFingerprint: string;
  promise: Promise<ToolResult>;
  resolve: (result: ToolResult) => void;
  reject: (error: unknown) => void;
};

type AvailableSkill = {
  name: string;
  sourcePath: string;
};

const CONNECTED_SESSION_STATES: ReadonlySet<SessionInfo["state"]> = new Set([
  "idle",
  "running",
  "waiting_input"
]);
const TERMINAL_SESSION_STATES: ReadonlySet<SessionInfo["state"]> = new Set([
  "completed",
  "failed",
  "stopped"
]);
const DEFAULT_FOCUS_LEASE_MS = 45_000;
const SKILL_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/u;
const PACKAGE_SKILLS_ROOT = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills"
);
const RECONNECT_HISTORY_TIMEOUT_MS = 5_000;
const RECONNECT_HISTORY_POLL_MS = 750;
const SAFE_PRE_DISPATCH_QUEUE_REJECTIONS: ReadonlySet<string> = new Set([
  "QUEUE_OWNER_CLOSED",
  "QUEUE_OWNER_SHUTTING_DOWN",
  "QUEUE_OWNER_OVERLOADED",
  "QUEUE_OWNER_GENERATION_MISMATCH"
]);
const MAX_ACTIVE_TURN_OUTPUT_CHARS = 120_000;
const MAX_CODEX_EVENT_TEXT_CHARS = 6_000;
const QUIESCENCE_CONTROL_TIMEOUT_MS = 1_000;
// Cold sandbox/Node startup can exceed one second. Allow each close protocol
// command to start, while keeping the entire runtime closure bounded.
const QUIESCENCE_RUNTIME_COMMAND_TIMEOUT_MS = 5_000;
const QUIESCENCE_RUNTIME_TIMEOUT_MS = 15_000;
const QUIESCENCE_DRAIN_TIMEOUT_MS = 4_000;
const QUIESCENCE_POLL_MS = 25;
const DEFAULT_ACTIVE_TURN_CHECKPOINT_MS = 30_000;

/**
 * How often live-turn progress (lastOutputAt, outputChars) is persisted. All
 * live turns share one tick so their checkpoints land in one group commit.
 * Status reads overlay the in-memory values, so this only bounds how stale the
 * persisted copy may be. `PUPPENCLAW_ACTIVE_TURN_CHECKPOINT_MS` overrides it.
 */
export function activeTurnCheckpointMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PUPPENCLAW_ACTIVE_TURN_CHECKPOINT_MS?.trim();
  return raw != null && /^\d{1,9}$/u.test(raw)
    ? Math.max(250, Number(raw))
    : DEFAULT_ACTIVE_TURN_CHECKPOINT_MS;
}
const RECOVERY_FENCE_TERMINATION_TIMEOUT_MS = 4_000;
const NO_FINAL_MESSAGE_STOP_REASON = "no_final_message";
const NO_FINAL_MESSAGE_STATUS_TEXT = "Runner completed without a final assistant message.";

type LinuxProcessIdentity = {
  processGroupId: number;
  processStartIdentity: string;
};

async function readLinuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity | null> {
  if (process.platform !== "linux") {
    return null;
  }
  const raw = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  if (raw == null) {
    return null;
  }
  const commandEnd = raw.lastIndexOf(")");
  if (commandEnd < 0) {
    return null;
  }
  const fields = raw.slice(commandEnd + 1).trim().split(/\s+/u);
  const processGroupId = Number.parseInt(fields[2] ?? "", 10);
  const startTicks = fields[19];
  if (!Number.isFinite(processGroupId) || startTicks == null) {
    return null;
  }
  return {
    processGroupId,
    processStartIdentity: `${pid}:${startTicks}`
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isReasoningOptionRejection(error: unknown): boolean {
  const message = ensureError(error).message;
  return /(?:unknown config option.*(?:effort|reasoning_effort)|invalid value for config option (?:effort|reasoning_effort)|(?:effort|reasoning).*not (?:available|supported)|unsupported.*(?:effort|reasoning))/iu.test(
    message
  );
}

function asOptionalString(value: unknown): string | undefined {
  const trimmed = asTrimmedString(value);
  return trimmed.length > 0 ? trimmed : undefined;
}

function asOptionalTextDelta(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toErrorRecord(event: JsonRecord | undefined): { code?: string; message: string } | null {
  if (event == null) {
    return null;
  }
  if (asTrimmedString(event.type) !== "error") {
    return null;
  }
  const code = asOptionalString(event.code);
  return {
    ...(code != null ? { code } : {}),
    message: asOptionalString(event.message) ?? "ACP runtime error"
  };
}

function isNoSessionStatus(event: JsonRecord | null): boolean {
  if (event == null) {
    return false;
  }
  const status = asTrimmedString(event.status).toLowerCase();
  if (status === "no-session") {
    return true;
  }
  const action = asTrimmedString(event.action).toLowerCase();
  return (
    action === "status_snapshot" &&
    asTrimmedString(event.summary).toLowerCase() === "no active session"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function pidMayExist(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function describeRuntimeStatus(status: RuntimeStatus): string {
  if (!status.exists) {
    return "no active session";
  }
  const raw = status.raw ?? {};
  const summary = asOptionalString(raw.summary);
  return [status.status, summary].filter(Boolean).join(": ") || "unknown";
}

function isRuntimeStatusReady(status: RuntimeStatus): boolean {
  if (!status.exists || status.status === "dead") {
    return false;
  }
  const raw = status.raw ?? {};
  const summary = asOptionalString(raw.summary);
  const combined = `${status.status ?? ""} ${summary ?? ""}`;
  return !/(no active session|needs reconnect|reconnect|starting|initializing|pending|dead)/iu.test(
    combined
  );
}

type RuntimeModeState = {
  currentMode: string;
  availableModes?: string[];
};

function modeIdFromValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return asOptionalString(value);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return asOptionalString(value.id) ?? asOptionalString(value.modeId);
}

function extractRuntimeModeState(value: unknown, depth = 0): RuntimeModeState | null {
  if (depth > 5 || !isRecord(value)) {
    return null;
  }
  const currentMode =
    modeIdFromValue(value.currentModeId) ??
    modeIdFromValue(value.currentMode) ??
    modeIdFromValue(value.mode) ??
    modeIdFromValue(value.current_mode_id) ??
    modeIdFromValue(value.desired_mode_id);
  const availableValues =
    (Array.isArray(value.availableModes) ? value.availableModes : undefined) ??
    (Array.isArray(value.modes) ? value.modes : undefined);
  if (currentMode != null && availableValues != null) {
    const availableModes = dedupeStrings(
      availableValues.map(modeIdFromValue).filter((mode): mode is string => mode != null)
    );
    if (availableModes.length > 0) {
      return { currentMode, availableModes };
    }
  }
  const configOptions =
    (Array.isArray(value.configOptions) ? value.configOptions : undefined) ??
    (Array.isArray(value.config_options) ? value.config_options : undefined);
  if (configOptions != null) {
    const modeOption = configOptions.find(
      (option) => isRecord(option) && asTrimmedString(option.id) === "mode"
    );
    if (isRecord(modeOption)) {
      const optionValues = Array.isArray(modeOption.options)
        ? modeOption.options.map((option) => {
            if (typeof option === "string") {
              return asOptionalString(option);
            }
            return isRecord(option)
              ? (asOptionalString(option.value) ?? asOptionalString(option.id))
              : undefined;
          })
        : [];
      const availableModes = dedupeStrings(
        optionValues.filter((mode): mode is string => mode != null)
      );
      const configuredCurrent =
        currentMode ??
        asOptionalString(modeOption.currentValue) ??
        asOptionalString(modeOption.current_value);
      if (configuredCurrent != null && availableModes.length > 0) {
        return { currentMode: configuredCurrent, availableModes };
      }
    }
  }
  for (const key of [
    "modeState",
    "sessionModeState",
    "acpx",
    "session",
    "runtime",
    "details",
    "capabilities",
    "options",
    "configOptions"
  ]) {
    const nested = extractRuntimeModeState(value[key], depth + 1);
    if (nested != null) {
      return nested;
    }
  }
  return currentMode != null ? { currentMode } : null;
}

function interactionPromptPrefix(mode: InteractionMode | undefined): string | undefined {
  if (mode === "plan") {
    return [
      "This is a read-only planning turn.",
      "Develop or revise the plan and surface genuine decision boundaries, but do not execute the plan or modify the workspace."
    ].join(" ");
  }
  if (mode === "execute") {
    return "This is the single approved execution turn. Carry out the approved work within the granted permissions and report the actual outcome.";
  }
  return undefined;
}

function mergeTurnSignals(...signals: Array<TurnSignals | undefined>): TurnSignals | undefined {
  const merged: TurnSignals = {};
  for (const signal of signals) {
    if (signal?.nativeMode != null) {
      merged.nativeMode = signal.nativeMode;
    }
    if (signal?.plan != null) {
      merged.plan = signal.plan;
    }
    if (signal?.inputRequest != null) {
      merged.inputRequest = signal.inputRequest;
    }
    if (signal?.stopReason != null) {
      merged.stopReason = signal.stopReason;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function signalsFromPromptEvents(events: readonly PromptEvent[], ignoreFailedInputRequests = false): TurnSignals | undefined {
  const toolStatuses = new Map<string, string>();
  if (ignoreFailedInputRequests) {
    for (const event of events) {
      if (event.type === "tool_call" && event.toolCallId != null && event.status != null) {
        toolStatuses.set(event.toolCallId, event.status);
      }
    }
  }
  let signals: TurnSignals | undefined;
  for (const event of events) {
    switch (event.type) {
      case "mode":
        signals = mergeTurnSignals(signals, { nativeMode: event.mode });
        break;
      case "plan":
        signals = mergeTurnSignals(signals, {
          plan: { source: "acp", entries: event.entries }
        });
        break;
      case "tool_call":
        if (event.nativeToolName === "ExitPlanMode") {
          signals = mergeTurnSignals(signals, {
            plan: {
              source: "claude-tool",
              ...(signals?.plan?.entries != null ? { entries: signals.plan.entries } : {})
            }
          });
        } else if (event.nativeToolName === "AskUserQuestion") {
          if (event.toolCallId != null && toolStatuses.get(event.toolCallId) === "failed") break;
          signals = mergeTurnSignals(signals, {
            inputRequest: {
              source: "claude-tool",
              toolName: "AskUserQuestion",
              ...(event.inputRequestText != null ? { text: event.inputRequestText } : {})
            }
          });
        }
        break;
      case "done":
        if (event.stopReason != null) {
          signals = mergeTurnSignals(signals, { stopReason: event.stopReason });
        }
        break;
      default:
        break;
    }
  }
  return signals;
}

function buildPermissionArgs(mode: PermissionMode): string[] {
  if (mode === "approve-all") {
    return ["--approve-all"];
  }
  if (mode === "deny-all") {
    return ["--deny-all"];
  }
  return ["--approve-reads"];
}

function initialPermissionModes(
  configuredBaseline: PermissionMode,
  requested: PermissionMode | undefined
): { baseline: PermissionMode; turn: PermissionMode } {
  return {
    baseline: configuredBaseline,
    turn:
      configuredBaseline === "deny-all"
        ? "deny-all"
        : (requested ?? configuredBaseline)
  };
}

function turnPermissionMode(
  baseline: PermissionMode,
  requested: PermissionMode | undefined
): PermissionMode {
  return baseline === "deny-all" ? "deny-all" : (requested ?? baseline);
}

function buildCodexPermissionArgs(mode: PermissionMode): string[] {
  return mode === "approve-all"
    ? ["--dangerously-bypass-approvals-and-sandbox"]
    : ["--sandbox", "read-only"];
}

// Read by the Codex provider wrapper. They come only from the session's
// validated modelProvider.subagents and resolved effort, never from the
// daemon's own environment.
const CODEX_SUBAGENT_POLICY_ENV_NAMES = [
  "PUPPENCLAW_MODEL_PROVIDER_SUBAGENT_MODEL",
  "PUPPENCLAW_MODEL_PROVIDER_SUBAGENT_EFFORT",
  "PUPPENCLAW_MODEL_PROVIDER_SUBAGENT_MAX_THREADS",
  "PUPPENCLAW_MODEL_PROVIDER_REASONING_EFFORT"
] as const;

function withoutInheritedCodexSubagentPolicy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed = { ...env };
  for (const name of CODEX_SUBAGENT_POLICY_ENV_NAMES) {
    delete scrubbed[name];
  }
  return scrubbed;
}

function buildCodexModelArgs(
  session: Pick<SessionInfo, "model" | "runtimeEffort" | "modelProvider">
): string[] {
  // With a local subagent policy the wrapper writes the main model and effort
  // into config.toml next to the pinned subagent roles. CLI overrides would
  // take precedence over those layers, so they are omitted.
  if (session.modelProvider?.subagents != null) {
    return [];
  }
  return [
    ...(session.model != null ? ["-m", session.model] : []),
    ...(session.runtimeEffort != null
      ? ["-c", `model_reasoning_effort="${session.runtimeEffort}"`]
      : [])
  ];
}

function buildCodexPermissionPrompt(promptText: string, mode: PermissionMode): string {
  if (mode !== "deny-all") {
    return promptText;
  }
  return [
    "Permission mode for this turn is deny-all.",
    "Do not call tools, execute commands, access external resources, or modify files. Answer only from the prompt and prior transcript.",
    "",
    promptText
  ].join("\n");
}

type CodexTurnPolicy =
  | "default"
  | "plan-no-tools"
  | "plan-read-tools"
  | "execute-tools"
  | "deny-all-no-tools";

function deriveCodexTurnPolicy(
  interactionMode: InteractionMode | undefined,
  permissionMode: PermissionMode
): CodexTurnPolicy {
  if (permissionMode === "deny-all") {
    return "deny-all-no-tools";
  }
  if (interactionMode === "plan") {
    return permissionMode === "approve-reads"
      ? "plan-read-tools"
      : "plan-no-tools";
  }
  if (interactionMode === "execute") {
    return "execute-tools";
  }
  return "default";
}

function parseJsonLines(value: string): JsonRecord[] {
  const events: JsonRecord[] = [];
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) {
        events.push(parsed);
      }
    } catch {
      // ignored intentionally
    }
  }
  return events;
}

function readMessages(value: JsonRecord | null | undefined): unknown[] {
  return Array.isArray(value?.messages) ? value.messages : [];
}

function extractTextContent(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractTextContent(entry));
  }
  if (!isRecord(value)) {
    return [];
  }
  const directText =
    asOptionalString(value.Text) ?? asOptionalString(value.text) ?? asOptionalString(value.content);
  return directText != null ? [directText] : [];
}

function sanitizeActiveTurnText(text: string): string {
  return redactSensitiveText(text);
}

function truncateOneLine(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/gu, " ").trim();
  if (oneLine.length <= maxChars) {
    return oneLine;
  }
  return `${oneLine.slice(0, maxChars)}...`;
}

function tailText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `[truncated ${text.length - maxChars} chars]\n${text.slice(-maxChars)}`;
}

type RuntimeTurnCursor = {
  recordId: string;
  userIds: ReadonlySet<string>;
  serializedSubmissionState: string;
};

function runtimeSubmissionState(record: JsonRecord): string {
  return JSON.stringify({
    messages: readMessages(record),
    lastRequestId: record.lastRequestId,
    lastPromptAt: record.lastPromptAt
  });
}

function runtimeTurnCursor(record: JsonRecord | null): RuntimeTurnCursor | undefined {
  const recordId = asOptionalString(record?.acpxRecordId);
  if (record == null || recordId == null || !Array.isArray(record.messages)) {
    return undefined;
  }
  const userIds = new Set<string>();
  for (const message of record.messages) {
    if (!isRecord(message) || !isRecord(message.User)) continue;
    const id = asOptionalString(message.User.id);
    if (id == null || userIds.has(id)) return undefined;
    userIds.add(id);
  }
  return { recordId, userIds, serializedSubmissionState: runtimeSubmissionState(record) };
}

function isRuntimeSubmissionUnchanged(
  cursor: RuntimeTurnCursor | undefined,
  record: JsonRecord | null
): boolean {
  return cursor != null && record != null && record.acpxRecordId === cursor.recordId &&
    Array.isArray(record.messages) &&
    runtimeSubmissionState(record) === cursor.serializedSubmissionState;
}

function extractCurrentTurnAgentText(
  record: JsonRecord | null,
  cursor: RuntimeTurnCursor | undefined,
  promptText: string
): string | undefined {
  if (cursor == null || record?.acpxRecordId !== cursor.recordId) return undefined;
  const messages = readMessages(record);
  let promptIndex: number | undefined;
  // ACPX history timestamps describe the whole record, not individual messages.
  // Only a unique new User.id can identify this submission. Replayed/ambiguous
  // user messages or an unidentifiable baseline must never resurrect old output.
  for (const [index, message] of messages.entries()) {
    if (!isRecord(message) || !isRecord(message.User)) continue;
    const id = asOptionalString(message.User.id);
    if (id == null) return undefined;
    if (cursor.userIds.has(id)) {
      if (promptIndex != null) return undefined;
      continue;
    }
    if (promptIndex != null || extractTextContent(message.User.content).join("\n\n") !== promptText) {
      return undefined;
    }
    promptIndex = index;
  }
  if (promptIndex == null) return undefined;
  return messages.slice(promptIndex + 1).flatMap((message) =>
    isRecord(message) && isRecord(message.Agent) ? extractTextContent(message.Agent.content) : []
  ).join("\n\n").trim() || undefined;
}

function createTextDeltaEvent(input: {
  payload: JsonRecord;
  stream: "output" | "thought";
  tag?: string;
}): PromptEvent | null {
  const content = input.payload.content;
  if (isRecord(content)) {
    const text = asOptionalTextDelta(content.text);
    if (text != null) {
      return {
        type: "text_delta",
        text,
        stream: input.stream,
        ...(input.tag != null ? { tag: input.tag } : {})
      };
    }
  }
  const text =
    asOptionalTextDelta(input.payload.text) ?? asOptionalTextDelta(input.payload.content);
  if (text == null) {
    return null;
  }
  return {
    type: "text_delta",
    text,
    stream: input.stream,
    ...(input.tag != null ? { tag: input.tag } : {})
  };
}

function resolveStructuredPayload(parsed: JsonRecord): {
  type: string;
  payload: JsonRecord;
  tag?: string;
} {
  if (isRecord(parsed.error)) {
    return {
      type: "error",
      payload: parsed.error
    };
  }
  if (asTrimmedString(parsed.method) === "session/update" && isRecord(parsed.params)) {
    const update = parsed.params.update;
    if (isRecord(update)) {
      const tag = asOptionalString(update.sessionUpdate);
      return {
        type: tag ?? "",
        payload: update,
        ...(tag != null ? { tag } : {})
      };
    }
  }
  const sessionUpdate = asOptionalString(parsed.sessionUpdate);
  if (sessionUpdate != null) {
    return {
      type: sessionUpdate,
      payload: parsed,
      tag: sessionUpdate
    };
  }
  const tag = asOptionalString(parsed.tag);
  return {
    type: asTrimmedString(parsed.type),
    payload: parsed,
    ...(tag != null ? { tag } : {})
  };
}

function extractClaudeNativeToolName(
  payload: JsonRecord
): "ExitPlanMode" | "AskUserQuestion" | undefined {
  const metadata = isRecord(payload._meta) ? payload._meta : undefined;
  const claudeCode = isRecord(metadata?.claudeCode) ? metadata.claudeCode : undefined;
  const toolName = asOptionalString(claudeCode?.toolName);
  return toolName === "ExitPlanMode" || toolName === "AskUserQuestion" ? toolName : undefined;
}

function extractQuestionText(value: unknown, depth = 0): string | undefined {
  if (depth > 5) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const question = extractQuestionText(entry, depth + 1);
      if (question != null) {
        return question;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const question = asOptionalString(value.question);
  if (question != null) {
    return question.slice(0, 2_000);
  }
  for (const key of ["questions", "input", "rawInput"]) {
    const nested = extractQuestionText(value[key], depth + 1);
    if (nested != null) {
      return nested;
    }
  }
  return undefined;
}

function parsePlanEntries(payload: JsonRecord): NativePlanEntry[] {
  if (!Array.isArray(payload.entries)) {
    return [];
  }
  return payload.entries.flatMap((entry): NativePlanEntry[] => {
    if (!isRecord(entry)) {
      return [];
    }
    const content = asOptionalString(entry.content);
    if (content == null) {
      return [];
    }
    const status = asOptionalString(entry.status);
    const priority = asOptionalString(entry.priority);
    return [
      {
        content,
        ...(status != null ? { status } : {}),
        ...(priority != null ? { priority } : {})
      }
    ];
  });
}

function parsePromptEventLine(line: string): PromptEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    // The JSON-RPC response to session/prompt carries the billable per-turn
    // usage on result.usage (the Claude ACP adapter reports input/output/cache
    // there). The session/update "usage_update" only carries the context-window
    // used/size — so without this the persistent path records no real tokens.
    // Surface it as a usage-bearing status event → recordNormalizedUsage.
    if (isRecord(parsed.result)) {
      const stopReason = asOptionalString(parsed.result.stopReason);
      if (stopReason != null) {
        const usage = normalizeUsage(parsed.result.usage);
        return {
          type: "done",
          stopReason,
          ...(hasNonzeroUsage(usage) ? { usage } : {})
        };
      }
      if (isRecord(parsed.result.usage)) {
        const usage = normalizeUsage(parsed.result.usage);
        if (hasNonzeroUsage(usage)) {
          return { type: "status", text: "usage recorded", usage };
        }
      }
    }
    const structured = resolveStructuredPayload(parsed);
    switch (structured.type) {
      case "text":
      case "agent_message_chunk":
        return createTextDeltaEvent({
          payload: structured.payload,
          stream: "output",
          ...(structured.tag != null ? { tag: structured.tag } : {})
        });
      case "thought":
      case "agent_thought_chunk":
        return createTextDeltaEvent({
          payload: structured.payload,
          stream: "thought",
          ...(structured.tag != null ? { tag: structured.tag } : {})
        });
      case "tool_call":
      case "tool_call_update": {
        const title = asOptionalString(structured.payload.title) ?? "tool call";
        const status = asOptionalString(structured.payload.status);
        const toolCallId = asOptionalString(structured.payload.toolCallId);
        const nativeToolName = extractClaudeNativeToolName(structured.payload);
        const inputRequestText =
          nativeToolName === "AskUserQuestion"
            ? extractQuestionText(structured.payload.rawInput)
            : undefined;
        return {
          type: "tool_call",
          text: status != null ? `${title} (${status})` : title,
          title,
          ...(status != null ? { status } : {}),
          ...(structured.tag != null ? { tag: structured.tag } : {}),
          ...(toolCallId != null ? { toolCallId } : {}),
          ...(nativeToolName != null ? { nativeToolName } : {}),
          ...(inputRequestText != null ? { inputRequestText } : {})
        };
      }
      case "plan":
        return {
          type: "plan",
          entries: parsePlanEntries(structured.payload)
        };
      case "current_mode_update": {
        const mode = asOptionalString(structured.payload.currentModeId);
        return mode == null ? null : { type: "mode", mode };
      }
      case "usage_update": {
        const used = asOptionalFiniteNumber(structured.payload.used);
        const size = asOptionalFiniteNumber(structured.payload.size);
        const usage = normalizeUsage(structured.payload);
        return {
          type: "status",
          text: used != null && size != null ? `usage updated: ${used}/${size}` : "usage updated",
          ...(structured.tag != null ? { tag: structured.tag } : {}),
          ...(used != null ? { used } : {}),
          ...(size != null ? { size } : {}),
          ...(hasNonzeroUsage(usage) ? { usage } : {})
        };
      }
      case "status": {
        const usage = normalizeUsage(structured.payload.usage);
        const used = asOptionalFiniteNumber(structured.payload.used);
        const size = asOptionalFiniteNumber(structured.payload.size);
        return {
          type: "status",
          text: asOptionalString(structured.payload.text) ?? asOptionalString(structured.payload.summary) ?? "ACP status updated",
          ...(used != null ? { used } : {}),
          ...(size != null ? { size } : {}),
          ...(hasNonzeroUsage(usage) ? { usage } : {})
        };
      }
      case "done": {
        const stopReason = asOptionalString(structured.payload.stopReason);
        return {
          type: "done",
          ...(stopReason != null ? { stopReason } : {})
        };
      }
      case "error": {
        const code = asOptionalString(structured.payload.code);
        const detailCode = asOptionalString(structured.payload.detailCode);
        const origin = asOptionalString(structured.payload.origin);
        const retryable =
          typeof structured.payload.retryable === "boolean"
            ? structured.payload.retryable
            : undefined;
        return {
          type: "error",
          message: asOptionalString(structured.payload.message) ?? "ACP runtime error",
          ...(code != null ? { code } : {}),
          ...(detailCode != null ? { detailCode } : {}),
          ...(origin != null ? { origin } : {}),
          ...(retryable != null ? { retryable } : {})
        };
      }
      default: {
        const statusText =
          asOptionalString(structured.payload.summary) ??
          asOptionalString(structured.payload.message) ??
          asOptionalString(structured.payload.update);
        if (statusText == null) {
          return null;
        }
        return {
          type: "status",
          text: statusText,
          ...(structured.tag != null ? { tag: structured.tag } : {})
        };
      }
    }
  } catch {
    return {
      type: "status",
      text: trimmed
    };
  }
}

function dedupeWarnings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function dedupeSkillNames(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function validateSkillNames(values: readonly string[]): string[] {
  const names = dedupeSkillNames(values);
  for (const name of names) {
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new PuppenclawError(
        "INVALID_SKILL_NAME",
        `Invalid skill name "${name}". Skill names may only contain letters, numbers, dot, underscore, and dash.`
      );
    }
  }
  return names;
}

async function isFile(path: string): Promise<boolean> {
  const file = await stat(path).catch(() => null);
  return file?.isFile() ?? false;
}

function mergeTranscript(
  previous: readonly SessionTranscriptEntry[],
  additions: readonly SessionTranscriptEntry[]
): SessionTranscriptEntry[] {
  return [...previous, ...additions];
}

function stampTranscriptTurn(
  entries: readonly SessionTranscriptEntry[],
  turnId: string | undefined
): SessionTranscriptEntry[] {
  if (turnId == null) {
    return [...entries];
  }
  return entries.map((entry) => ({ ...entry, turnId }));
}

function isConnectedSession(session: SessionInfo): boolean {
  return CONNECTED_SESSION_STATES.has(session.state);
}

function isTerminalSession(session: SessionInfo): boolean {
  return TERMINAL_SESSION_STATES.has(session.state);
}

function isFocusLeaseActive(session: SessionInfo, nowMs = Date.now()): boolean {
  if (session.focusedUntil == null) {
    return false;
  }
  const leaseUntil = Date.parse(session.focusedUntil);
  return Number.isFinite(leaseUntil) && leaseUntil > nowMs;
}

function withoutFocusLease(session: SessionInfo): SessionInfo {
  const { focusedUntil: _focusedUntil, ...rest } = session;
  return rest;
}

function withoutRecoveryFence(session: SessionInfo): SessionInfo {
  const { recoveryFence: _recoveryFence, ...rest } = session;
  return rest;
}

function resolveQuestionFromOutput(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) {
    return undefined;
  }
  const paragraphs = trimmed
    .split(/\n\s*\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const candidate = paragraphs.at(-1) ?? trimmed;
  if (/^(question|need input|user input)\s*[:\-]/iu.test(candidate)) {
    return candidate;
  }
  return undefined;
}

function makeAssistantTranscript(text: string): SessionTranscriptEntry[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  return [
    {
      role: "assistant",
      text: trimmed,
      createdAt: nowIso()
    }
  ];
}

function splitCommandLine(input: string): string[] {
  const matches = input.match(/"([^"]*)"|'([^']*)'|[^\s]+/gu) ?? [];
  return matches.map((part) => {
    if (
      (part.startsWith('"') && part.endsWith('"')) ||
      (part.startsWith("'") && part.endsWith("'"))
    ) {
      return part.slice(1, -1);
    }
    return part;
  });
}

function shellQuote(value: string): string {
  if (process.platform === "win32") {
    if (/^[A-Za-z0-9_./:@%+=,\\-]+$/u.test(value)) {
      return value;
    }
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replace(/'/gu, `'\"'\"'`)}'`;
}

function resolveSpawnCommand(commandText: string, args: string[]): SpawnCommand {
  const trimmed = commandText.trim();
  const parts = splitCommandLine(trimmed);
  if (parts.length === 0) {
    return {
      command: "acpx",
      args,
      shell: false
    };
  }
  const command = parts[0];
  if (command == null) {
    return {
      command: "acpx",
      args,
      shell: false
    };
  }
  const commandArgs = [...parts.slice(1), ...args];
  if (shouldUseShellForSpawnCommand(command)) {
    const suffix = commandArgs.map((value) => shellQuote(value)).join(" ");
    return {
      command: suffix.length > 0 ? `${shellQuote(command)} ${suffix}` : shellQuote(command),
      args: [],
      shell: true
    };
  }
  return {
    command,
    args: commandArgs,
    shell: false
  };
}

function childExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function shouldUseShellForSpawnCommand(command: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const extension = extname(command).toLowerCase();
  if (extension === ".exe" || extension === ".com") {
    return false;
  }
  if (extension === ".cmd" || extension === ".bat" || extension === ".ps1") {
    return true;
  }
  if (command.includes("\\") || command.includes("/")) {
    return false;
  }
  return true;
}

function makeUserTranscript(text: string): SessionTranscriptEntry[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  return [
    {
      role: "user",
      text: trimmed,
      createdAt: nowIso()
    }
  ];
}

function formatTokenCount(value: number): string {
  return Math.trunc(value).toLocaleString("en-US");
}

function formatUsageLine(usage: NormalizedUsage): string {
  return `${formatTokenCount(usage.input)} in / ${formatTokenCount(usage.output)} out / ${formatTokenCount(
    usage.cacheRead
  )} cacheRead / ${formatTokenCount(usage.cacheWrite)} cacheWrite (${formatTokenCount(usage.total)} total)`;
}

function deriveUsageProvider(session: SessionInfo): string {
  switch (session.modelProvider?.kind) {
    case "claude-code":
      return "anthropic";
    case "codex-openai":
      return "openai";
    case "codex-openai-compatible":
      return session.modelProvider.id ?? "openai-compatible";
    default:
      return session.agent === "codex" ? "openai" : "anthropic";
  }
}

/** Deterministic per turn and (role, model), so a re-recorded turn cannot duplicate rows. */
function modelUsageLedgerId(turnId: string, role: ModelUsageRole, model: string): string {
  const modelKey = createHash("sha256").update(model).digest("hex").slice(0, 16);
  return `usage-${turnId}-${role}-${modelKey}`;
}

function deriveUsageModel(session: SessionInfo): string {
  return (
    session.model ??
    session.modelProvider?.model ??
    (session.agent === "codex" ? "codex-default" : "claude-default")
  );
}

export class AcpxSessionManager implements ISessionManager {
  private readonly activeTurns = new Set<string>();
  private readonly stopRequests = new Set<string>();
  private readonly activeTurnOutputs = new Map<string, ActiveTurnOutput>();
  private readonly deferredControllerCompletions = new Set<string>();
  private readonly activeTurnProcesses = new Map<string, ActiveTurnProcess>();
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private admissionTail: Promise<void> = Promise.resolve();
  private readonly capacityReservations = new Map<string, number>();
  private readonly forkTargetClaims = new Set<string>();
  private readonly activeTurnIds = new Map<string, string>();
  private readonly dirtyActiveTurnCheckpoints = new Set<string>();
  private activeTurnCheckpointTimer: NodeJS.Timeout | null = null;
  private readonly activeTurnPersistence = new Map<string, Promise<void>>();
  private readonly activeTurnCompletion = new Map<
    string,
    { promise: Promise<void>; resolve: () => void }
  >();
  private readonly keyedTurnExecutions = new Map<string, KeyedTurnExecution>();
  /**
   * Model/effort config options last applied to each live ACP runtime. Each
   * redundant `set` control command pays a full adapter spawn (~8s); acpx
   * persists config options per session, so unchanged values can be skipped.
   * In-memory on purpose: after a daemon restart the first turn re-applies.
   */
  private readonly appliedRuntimeConfigBySession = new Map<
    string,
    { model?: string; effort?: EffortLevel }
  >();

  constructor(
    private readonly deps: {
      config: ParsedPluginConfig;
      logger: PluginLogger;
      store: SessionStore;
      outputRouter: OutputRouter;
      ledger?: UsageLedgerStore;
      statistics?: TurnStatisticsRecorder;
      advanced?: AdvancedRuntime;
      runners?: RunnerRegistry;
    }
  ) {}

  /** Turns admitted in this process and not yet settled (counts only, for ops and health). */
  activeTurnCount(): number {
    return this.activeTurns.size;
  }

  /** Turn processes this process spawned that have not closed yet. */
  activeTurnProcessCount(): number {
    return this.activeTurnProcesses.size;
  }

  private recordTurnUsage(session: SessionInfo, turn: TurnResult): void {
    if (this.deps.advanced?.metered(session.name)) return;
    if (this.deps.ledger == null || turn.state === "failed") {
      return;
    }
    if (turn.modelUsage != null) {
      this.recordModelUsageRows(session, turn, turn.modelUsage);
      return;
    }
    const usage = turn.usage;
    if (usage == null || !hasNonzeroUsage(usage)) {
      return;
    }
    try {
      this.deps.ledger.append({
        id: `usage-${randomUUID()}`,
        sessionName: session.name,
        agent: session.agent,
        provider: deriveUsageProvider(session),
        model: deriveUsageModel(session),
        usage,
        ...(turn.stopReason != null ? { stopReason: turn.stopReason } : {}),
        durationMs: turn.durationMs ?? 0,
        timestamp: nowIso()
      });
    } catch (error) {
      this.deps.logger.warn(
        `Orchestrator usage ledger append failed for ${session.name}: ${ensureError(error).message}`
      );
    }
  }

  /**
   * One ledger row per (role, model) of the turn. The main row keeps today's
   * provider/model derivation; subagent rows keep the session provider, name
   * the model that actually ran and say whether they were local model workers
   * (then they ran on the local model, not on that provider). All rows share
   * turnId and timestamp.
   */
  private recordModelUsageRows(session: SessionInfo, turn: TurnResult, modelUsage: TurnModelUsage): void {
    const timestamp = nowIso();
    const provider = deriveUsageProvider(session);
    const entries: UsageLedgerEntry[] = modelUsage.entries
      .filter((entry) => hasNonzeroUsage(entry.usage))
      .map((entry) => ({
        id: modelUsageLedgerId(modelUsage.turnId, entry.role, entry.model),
        sessionName: session.name,
        agent: session.agent,
        provider,
        model: entry.role === "main" ? deriveUsageModel(session) : entry.model,
        usage: entry.usage,
        ...(turn.stopReason != null ? { stopReason: turn.stopReason } : {}),
        durationMs: turn.durationMs ?? 0,
        timestamp,
        turnId: modelUsage.turnId,
        role: entry.role,
        threads: entry.threads,
        ...(entry.role === "subagent" ? { localWorkers: modelUsage.localWorkers } : {})
      }));
    try {
      this.deps.ledger?.appendMany(entries);
    } catch (error) {
      this.deps.logger.warn(
        `Orchestrator usage ledger append failed for ${session.name}: ${ensureError(error).message}`
      );
    }
  }

  private async withStatisticsTurn(params: StartParams | SendParams, run: () => Promise<ToolResult>): Promise<ToolResult> {
    if (params.statisticsContext == null) return await run();
    const statistics = this.deps.statistics;
    if (statistics == null) throw new PuppenclawError("STATISTICS_UNAVAILABLE", "This runner does not support durable conversation statistics.");
    const stored = this.deps.store.getSession(params.name);
    const agent = "agent" in params ? params.agent : stored?.agent;
    if (agent == null) throw new PuppenclawError("NO_SESSION", "Unknown statistics session.");
    const turnId = statistics.admit(params.statisticsContext, {
      name: params.name, agent,
      model: ("model" in params ? params.model : undefined) ?? params.modelProvider?.model ?? stored?.model,
      modelProviderId: params.modelProviderId ?? stored?.modelProviderId
    }, params.turnKey);
    this.activeTurnIds.set(params.name, turnId);
    try {
      const result = await run();
      await this.deps.advanced?.closeTurn(params.name);
      await statistics.settle(params.name, "completed");
      return result;
    } catch (error) {
      const stopped = this.stopRequests.has(params.name) || this.deps.store.getSession(params.name)?.state === "stopped";
      await this.deps.advanced?.closeTurn(params.name);
      await statistics.settle(params.name, stopped ? "cancelled" : "failed");
      throw error;
    } finally {
      if (this.activeTurnIds.get(params.name) === turnId) this.activeTurnIds.delete(params.name);
    }
  }

  async start(params: StartParams): Promise<ToolResult> {
    return await this.runSessionTurn(
      params.name,
      params.lifecycleEpoch,
      this.deps.store.getTurnGeneration(params.name),
      params.turnKey == null
        ? undefined
        : {
            operation: "start",
            turnKey: params.turnKey,
            requestFingerprint: fingerprintStartRequest(params)
          },
      async () => await this.withStatisticsTurn(params, () => this.startTurn(params))
    );
  }

  private async startTurn(params: StartParams): Promise<ToolResult> {
      const directory = resolvePath(params.directory);
      const now = nowIso();
      const requestedSkills = validateSkillNames(params.skills ?? []);
      const existing = this.deps.store.getSession(params.name);
      if (existing != null) {
        if (
          existing.agent === "claude" &&
          [params.model, params.modelProvider?.model].some((model) =>
            model != null && requiresFreshClaudeTranscript(
              existing.modelProvider?.model ?? existing.model, model
            )
          )
        ) {
          throw new PuppenclawError(
            "MODEL_TRANSCRIPT_INCOMPATIBLE",
            "This model change requires a fresh runner session rehydrated from visible conversation only; native Fable thinking cannot be resumed by another generation."
          );
        }
        if (existing.agent !== params.agent) {
          throw new PuppenclawError(
            "SESSION_CONFLICT",
            `Session ${params.name} already exists for agent ${existing.agent}.`
          );
        }
        if (resolvePath(existing.directory) !== directory) {
          throw new PuppenclawError(
            "SESSION_CONFLICT",
            `Session ${params.name} already points at ${existing.directory}.`
          );
        }
        if (
          params.ownerKey != null &&
          this.deps.store.getSessionOwner(params.name) !== params.ownerKey
        ) {
          throw new PuppenclawError(
            "SESSION_OWNER_CONFLICT",
            `Session ${params.name} belongs to a different account scope.`
          );
        }
      }
      const permissionModes =
        existing == null
          ? initialPermissionModes(this.deps.config.permissionMode, params.permissionMode)
          : {
              baseline: existing.permissionMode,
              turn: turnPermissionMode(existing.permissionMode, params.permissionMode)
            };
      const requestedRuntime = existing ?? {
        agent: params.agent,
        ...(params.modelProvider != null ? { modelProvider: params.modelProvider } : {})
      };
      if (
        (existing == null || !isConnectedSession(existing)) &&
        !this.usesOneShotRuntime(requestedRuntime)
      ) {
        await this.ensureConnectedCapacity(params.name);
      }

      const installedSkills = await this.installSessionSkills(directory, requestedSkills);
      this.assertTurnWasNotStopped(params.name);
      const installedSkillNames = installedSkills.map((skill) => skill.name);
      const baseSession =
        existing ??
        this.createSession({
          name: params.name,
          agent: params.agent,
          directory,
          permissionMode: permissionModes.baseline,
          ...(params.effort != null ? { effort: params.effort } : {}),
          ...(params.planningProfile != null ? { planningProfile: params.planningProfile } : {}),
          ...(params.model != null ? { model: params.model } : {}),
          ...(params.modelProviderId != null ? { modelProviderId: params.modelProviderId } : {}),
          ...(params.modelProvider != null ? { modelProvider: params.modelProvider } : {}),
          ...(installedSkillNames.length > 0 ? { skills: installedSkillNames } : {}),
          createdAt: now
        });
      const requestedSession =
        existing != null && params.effort != null
          ? { ...baseSession, effort: params.effort }
          : baseSession;
      const reasoning = this.resolveSessionReasoning(requestedSession);
      const session = { ...reasoning.session, ...(params.orchestration ? { orchestration: params.orchestration } : {}) };
      const sessionSkills = dedupeSkillNames([...(session.skills ?? []), ...installedSkillNames]);

      const warnings = dedupeWarnings([
        ...session.warnings,
        ...(reasoning.warning != null ? [reasoning.warning] : []),
        ...this.resolveCapabilityWarnings({
          agent: params.agent,
          ...(params.model != null ? { model: params.model } : {}),
          ...(params.effort != null ? { effort: params.effort } : {}),
          ...(params.planningProfile != null ? { planningProfile: params.planningProfile } : {})
        })
      ]);

      const provisionalSession: SessionInfo = {
        ...session,
        state: "running",
        lastActivity: now,
        warnings,
        ...(sessionSkills.length > 0 ? { skills: sessionSkills } : {}),
        handle: {
          runtimeSessionName: params.name,
          cwd: directory,
          agent: params.agent,
          mode: "persistent"
        }
      };
      // Persist the identity before starting external runtime work. A cleanup
      // request racing an ambiguous start response can then fence this runtime.
      await this.deps.store.upsertSession(provisionalSession, params.ownerKey);
      this.assertTurnWasNotStopped(params.name);
      await this.deps.advanced?.begin(provisionalSession, params, permissionModes.turn);

      try {
        if (!this.usesOneShotRuntime(session)) {
          await this.ensureRuntimeSession({
            name: params.name,
            agent: params.agent,
            directory,
            ...((params.model ?? session.model) ? { model: params.model ?? session.model } : {}),
            ...(session.runtimeEffort != null ? { effort: session.runtimeEffort } : {}),
            ...(session.agent === "claude" ? { ultracode: session.effort === "ultracode" } : {}),
            ...((params.modelProvider ?? session.modelProvider)
              ? { modelProvider: params.modelProvider ?? session.modelProvider }
              : {})
          });
        }

        this.assertTurnWasNotStopped(params.name);

        const context = await loadContextFiles(directory, params.contextFiles);
        this.assertTurnWasNotStopped(params.name);
        const promptText = [
          interactionPromptPrefix(params.interactionMode),
          this.buildPlanningPromptPrefix({
            agent: params.agent,
            ...((params.planningProfile ?? session.planningProfile)
              ? { planningProfile: params.planningProfile ?? session.planningProfile }
              : {})
          }),
          params.task.trim(),
          context.promptText
        ]
          .filter(Boolean)
          .join("\n\n");
        const runtimePromptText =
          session.state === "suspended"
            ? this.buildRehydrationPrompt(session, promptText)
            : promptText;
        const effectivePromptText = this.usesOneShotRuntime(session)
          ? this.buildOneShotContinuationPrompt(session, runtimePromptText)
          : runtimePromptText;
        const effectivePermissionMode = permissionModes.turn;
        let turn: TurnResult;
        try {
          turn = await this.runTurn({
            session,
            promptText: effectivePromptText,
            permissionMode: effectivePermissionMode,
            ...(params.interactionMode != null ? { interactionMode: params.interactionMode } : {})
          });
        } catch (error) {
          const normalizedError = normalizeProviderError(session, error);
          const durableError = durableTurnError(normalizedError);
          const retryable =
            normalizedError instanceof PuppenclawError &&
            typeof normalizedError.details?.retryable === "boolean"
              ? normalizedError.details.retryable
              : undefined;
          await this.persistFinalTurnSession(
            params.name,
            "failed",
            (current, activeTurn) => ({
              ...current,
              state: "failed",
              lastActivity: nowIso(),
              lastError: durableError.message,
              failureCode: durableError.code,
              ...(retryable != null ? { retryable } : {}),
              ...(activeTurn != null ? { activeTurn } : {})
            }),
            durableError.message,
            durableError,
            { code: durableError.code, ...(retryable != null ? { retryable } : {}) }
          );
          throw normalizedError;
        }
        const nextSession = await this.persistFinalTurnSession(
          params.name,
          turn.state === "failed" ? "failed" : "completed",
          (current, activeTurn, stoppedDuringTurn) => ({
            ...current,
            ...withoutFocusLease(session),
            ...(current.focusedUntil != null ? { focusedUntil: current.focusedUntil } : {}),
            permissionMode: permissionModes.baseline,
            state: stoppedDuringTurn ? "stopped" : turn.state,
            lastActivity: nowIso(),
            warnings: dedupeWarnings([...warnings, ...turn.warnings]),
            ...(sessionSkills.length > 0 ? { skills: sessionSkills } : {}),
            transcript: mergeTranscript(
              current.transcript,
              stampTranscriptTurn(
                [...makeUserTranscript(promptText), ...turn.transcript],
                activeTurn?.id
              )
            ),
            ...(turn.question != null ? { pendingQuestion: turn.question } : {}),
            ...(turn.state === "failed"
              ? {
                  lastError: turn.output || current.lastError || "ACP turn failed.",
                  ...(turn.failureCode != null ? { failureCode: turn.failureCode } : {}),
                  ...(turn.retryable != null ? { retryable: turn.retryable } : {})
                }
              : {}),
            ...(turn.tokenUsage != null
              ? { tokenUsage: turn.tokenUsage }
              : current.tokenUsage != null
                ? { tokenUsage: current.tokenUsage }
                : {}),
            handle: {
              runtimeSessionName: params.name,
              cwd: directory,
              agent: params.agent,
              mode: "persistent"
            },
            ...(stoppedDuringTurn ? { lastStopReason: "stopped by user" } : {}),
            ...(activeTurn != null ? { activeTurn } : {})
          }),
          turn.state === "failed" ? turn.output : undefined,
          {
            kind: "success",
            version: 1,
            summary: `Started session ${params.name}.`,
            output: turn.output,
            outputRole: outputRoleForTurn(turn),
            ...(turn.failureCode != null ? { failureCode: turn.failureCode } : {}),
            ...(turn.retryable != null ? { retryable: turn.retryable } : {}),
            ...(turn.signals != null ? { turnSignals: turn.signals } : {}),
            contextFiles: context.files.map((file) => ({
              path: basename(file.path),
              bytes: file.bytes,
              truncated: file.truncated
            })),
            skills: installedSkills.map(({ name }) => ({ name }))
          },
          turn.failureCode != null
            ? { code: turn.failureCode, ...(turn.retryable != null ? { retryable: turn.retryable } : {}) }
            : undefined
        );
        this.recordTurnUsage(nextSession, turn);
        return textToolResult(`Started session ${params.name}.`, {
          session: this.withBrokerSocket(nextSession),
          output: turn.output,
          outputRole: outputRoleForTurn(turn),
          ...(turn.failureCode != null ? { failureCode: turn.failureCode } : {}),
          ...(turn.retryable != null ? { retryable: turn.retryable } : {}),
          ...(turn.signals != null ? { turnSignals: turn.signals } : {}),
          contextFiles: context.files,
          skills: installedSkills
        });
      } catch (error) {
        const normalizedError = normalizeProviderError(session, error);
        if (
          this.keyedTurnExecutions.get(params.name) == null &&
          this.deps.store.getActiveQuiescenceEpoch(params.name) == null
        ) {
          await this.deps.store.patchSession(params.name, (current) => {
            if (current?.state === "stopped" || current?.activeTurn?.state === "failed") {
              return current;
            }
            return {
              ...(current ?? provisionalSession),
              state: "failed",
              lastActivity: nowIso(),
              lastError: normalizedError.message,
              ...(normalizedError instanceof PuppenclawError
                ? {
                    failureCode: normalizedError.code,
                    ...(typeof normalizedError.details?.retryable === "boolean"
                      ? { retryable: normalizedError.details.retryable }
                      : {})
                  }
                : {})
            };
          });
        }
        throw normalizedError;
      }
  }

  async send(params: SendParams): Promise<ToolResult> {
    return await this.runSessionTurn(
      params.name,
      params.lifecycleEpoch,
      this.deps.store.getTurnGeneration(params.name),
      params.turnKey == null
        ? undefined
        : {
            operation: "send",
            turnKey: params.turnKey,
            requestFingerprint: fingerprintSendRequest(params)
          },
      async () => await this.withStatisticsTurn(params, async () => {
      const storedSession = this.requireSession(params.name);
      const providerRefresh = await this.prepareModelProviderRefresh(storedSession, params);
      const session = providerRefresh.session;
      const requestedSession =
        params.effort == null ? session : { ...session, effort: params.effort };
      const reasoning = this.resolveSessionReasoning(requestedSession);
      const effectiveSession = { ...reasoning.session, ...(params.orchestration ? { orchestration: params.orchestration } : {}) };
      await this.deps.advanced?.begin(effectiveSession, params, turnPermissionMode(this.effectivePermissionMode(session), params.permissionMode));
      if (providerRefresh.refreshed || params.orchestration) {
        // Persist the daemon-validated provider selection before launching the
        // external turn. A failed provider turn must not make the next retry
        // silently fall back to stale endpoint or model metadata.
        await this.deps.store.upsertSession(effectiveSession);
      }
      if (!isConnectedSession(session) && !this.usesOneShotRuntime(effectiveSession)) {
        await this.ensureConnectedCapacity(params.name);
      }
      if (!this.usesOneShotRuntime(effectiveSession)) {
        try {
          await this.ensureRuntimeSession({
            name: effectiveSession.name,
            agent: effectiveSession.agent,
            directory: effectiveSession.directory,
            ...(effectiveSession.model != null ? { model: effectiveSession.model } : {}),
            ...(effectiveSession.runtimeEffort != null
              ? { effort: effectiveSession.runtimeEffort }
              : {}),
            ...(effectiveSession.agent === "claude" ? { ultracode: effectiveSession.effort === "ultracode" } : {}),
            ...(effectiveSession.modelProvider != null
              ? { modelProvider: effectiveSession.modelProvider }
              : {})
          });
        } catch (error) {
          const normalizedError = normalizeProviderError(effectiveSession, error);
          if (normalizedError instanceof PuppenclawError) {
            await this.deps.store.patchSession(params.name, (current) =>
              current == null
                ? null
                : {
                    ...current,
                    state: "failed",
                    lastActivity: nowIso(),
                    lastError: normalizedError.message,
                    failureCode: normalizedError.code,
                    ...(typeof normalizedError.details?.retryable === "boolean"
                      ? { retryable: normalizedError.details.retryable }
                      : {})
                  }
            );
          }
          throw normalizedError;
        }
      }
      const context = await loadContextFiles(session.directory, params.contextFiles);
      const prefix =
        effectiveSession.effort == null && params.ultrathink === true
          ? effectiveSession.reasoningProfile === "claude"
            ? "ultrathink\n\n"
            : "Use a high-effort reasoning pass for this reply.\n\n"
          : "";
      const promptText = [
        interactionPromptPrefix(params.interactionMode),
        prefix + params.message.trim(),
        context.promptText
      ]
        .filter(Boolean)
        .join("\n\n");
      const runtimePromptText =
        session.state === "suspended"
          ? this.buildRehydrationPrompt(session, promptText)
          : promptText;
      const effectivePromptText = this.usesOneShotRuntime(effectiveSession)
        ? this.buildOneShotContinuationPrompt(effectiveSession, runtimePromptText)
        : runtimePromptText;
      const effectivePermissionMode = turnPermissionMode(
        this.effectivePermissionMode(session),
        params.permissionMode
      );
      let turn: TurnResult;
      try {
        turn = await this.runTurn({
          session: effectiveSession,
          promptText: effectivePromptText,
          permissionMode: effectivePermissionMode,
          ...(params.interactionMode != null ? { interactionMode: params.interactionMode } : {})
        });
      } catch (error) {
        const normalizedError = normalizeProviderError(effectiveSession, error);
        const durableError = durableTurnError(normalizedError);
        const retryable =
          normalizedError instanceof PuppenclawError &&
          typeof normalizedError.details?.retryable === "boolean"
            ? normalizedError.details.retryable
            : undefined;
        await this.persistFinalTurnSession(
          params.name,
          "failed",
          (current, activeTurn) => ({
            ...current,
            state: "failed",
            lastActivity: nowIso(),
            lastError: durableError.message,
            failureCode: durableError.code,
            ...(retryable != null ? { retryable } : {}),
            ...(activeTurn != null ? { activeTurn } : {})
          }),
          durableError.message,
          durableError,
          { code: durableError.code, ...(retryable != null ? { retryable } : {}) }
        );
        throw normalizedError;
      }
      const nextSession = await this.persistFinalTurnSession(
        params.name,
        turn.state === "failed" ? "failed" : "completed",
        (current, activeTurn, stoppedDuringTurn) => ({
          ...current,
          ...withoutFocusLease(effectiveSession),
          ...(current.focusedUntil != null ? { focusedUntil: current.focusedUntil } : {}),
          permissionMode:
            params.permissionMode == null ? effectivePermissionMode : session.permissionMode,
          state: stoppedDuringTurn ? "stopped" : turn.state,
          lastActivity: nowIso(),
          warnings: dedupeWarnings([
            ...current.warnings,
            ...(reasoning.warning != null ? [reasoning.warning] : []),
            ...turn.warnings
          ]),
          transcript: mergeTranscript(
            current.transcript,
            stampTranscriptTurn(
              [...makeUserTranscript(promptText), ...turn.transcript],
              activeTurn?.id
            )
          ),
          ...(turn.question != null ? { pendingQuestion: turn.question } : {}),
          ...(turn.state === "failed"
            ? {
                lastError: turn.output || current.lastError || "ACP turn failed.",
                ...(turn.failureCode != null ? { failureCode: turn.failureCode } : {}),
                ...(turn.retryable != null ? { retryable: turn.retryable } : {})
              }
            : {}),
          ...(turn.tokenUsage != null
            ? { tokenUsage: turn.tokenUsage }
            : current.tokenUsage != null
              ? { tokenUsage: current.tokenUsage }
              : {}),
          ...(stoppedDuringTurn ? { lastStopReason: "stopped by user" } : {}),
          ...(activeTurn != null ? { activeTurn } : {})
        }),
        turn.state === "failed" ? turn.output : undefined,
        {
          kind: "success",
          version: 1,
          summary: `Updated session ${params.name}.`,
          output: turn.output,
          outputRole: outputRoleForTurn(turn),
          ...(turn.failureCode != null ? { failureCode: turn.failureCode } : {}),
          ...(turn.retryable != null ? { retryable: turn.retryable } : {}),
          ...(turn.signals != null ? { turnSignals: turn.signals } : {}),
          contextFiles: context.files.map((file) => ({
            path: basename(file.path),
            bytes: file.bytes,
            truncated: file.truncated
          }))
        },
        turn.failureCode != null
          ? { code: turn.failureCode, ...(turn.retryable != null ? { retryable: turn.retryable } : {}) }
          : undefined
      );
      this.recordTurnUsage(nextSession, turn);
      return textToolResult(`Updated session ${params.name}.`, {
        session: this.withBrokerSocket(nextSession),
        output: turn.output,
        outputRole: outputRoleForTurn(turn),
        ...(turn.failureCode != null ? { failureCode: turn.failureCode } : {}),
        ...(turn.retryable != null ? { retryable: turn.retryable } : {}),
        ...(turn.signals != null ? { turnSignals: turn.signals } : {}),
        contextFiles: context.files
      });
      })
    );
  }

  /**
   * Boot reaper (`PUPPENCLAW_BOOT_REAPER=on`): once a restart has settled a turn
   * as interrupted, its persistent acpx runtime must not keep executing it.
   * Asks each named runtime to cancel its in-flight prompt. Best effort, bounded
   * per command; direct one-shot runtimes have no separate runtime to cancel.
   */
  async cancelInterruptedRuntimeTurns(names: readonly string[]): Promise<number> {
    const targets = names
      .map((name) => this.deps.store.getSession(name))
      .filter(
        (session): session is SessionInfo =>
          session != null && !this.usesOneShotRuntime(session) && !this.activeTurns.has(session.name)
      );
    let cancelled = 0;
    for (let index = 0; index < targets.length; index += 4) {
      const settled = await Promise.allSettled(
        targets.slice(index, index + 4).map(async (session) => {
          const runtimeEnv = this.modelProviderRuntimeEnv(session.modelProvider, session.name);
          await this.runControlCommand({
            args: this.buildVerbArgs(session.agent, session.directory, ["cancel", "--session", session.name]),
            cwd: session.directory,
            allowNoSession: true,
            timeoutMs: QUIESCENCE_RUNTIME_COMMAND_TIMEOUT_MS,
            ...(runtimeEnv != null ? { env: runtimeEnv } : {})
          });
        })
      );
      for (const [offset, result] of settled.entries()) {
        if (result.status === "fulfilled") {
          cancelled += 1;
        } else {
          this.deps.logger.warn(
            `Boot reaper could not cancel the runtime turn of ${targets[index + offset]?.name}: ${redactSensitiveText(ensureError(result.reason).message)}`
          );
        }
      }
    }
    return cancelled;
  }

  async stop(params: StopParams): Promise<ToolResult> {
    return await this.withLifecycleLock(params.name, async () => {
      this.deps.store.assertSessionMutable(params.name);
      if (this.activeTurns.has(params.name)) this.stopRequests.add(params.name);
      await this.deps.advanced?.closeTurn(params.name);
      let runningReceipt = Object.values(this.deps.store.getTurnRequests(params.name)).find(
        (receipt) => receipt.state === "running"
      );
      let session = this.deps.store.getSession(params.name);
      const hadUnpublishedTurn = session == null && this.activeTurns.has(params.name);
      if (hadUnpublishedTurn) {
        this.stopRequests.add(params.name);
        this.terminateActiveTurnProcess(params.name, "SIGTERM");
        const drained = await this.waitForActiveTurnDrain(params.name);
        if (!drained) {
          throw new PuppenclawError(
            "QUIESCENCE_UNAVAILABLE",
            `Unpublished turn for session ${params.name} did not drain after Stop.`
          );
        }
        session = this.deps.store.getSession(params.name);
        runningReceipt = Object.values(this.deps.store.getTurnRequests(params.name)).find(
          (receipt) => receipt.state === "running"
        );
      }
      if (session == null) {
        if (runningReceipt == null) {
          if (hadUnpublishedTurn) {
            this.stopRequests.delete(params.name);
            return textToolResult(`Stopped unpublished turn for session ${params.name}.`, {
              sessionName: params.name,
              stopped: true
            });
          }
          throw new PuppenclawError("NO_SESSION", `Unknown session ${params.name}.`);
        }
        await this.deps.store.settleTurnRequestError(
          params.name,
          runningReceipt.turnKey,
          runningReceipt.requestFingerprint,
          durableTurnError(
            new PuppenclawError(
              "TURN_ABORTED",
              `Unpublished turn ${runningReceipt.turnKey} was stopped by the operator before replay could be proved.`
            )
          )
        );
        this.stopRequests.delete(params.name);
        return textToolResult(`Stopped unresolved turn for session ${params.name}.`, {
          sessionName: params.name,
          turnReceipt: { turnKey: runningReceipt.turnKey, state: "accepted" }
        });
      }
      const runtimeEnv = this.modelProviderRuntimeEnv(session.modelProvider, session.name);
      this.stopRequests.add(params.name);
      const hadActiveTurn = this.activeTurns.has(params.name);
      await this.runControlCommand({
        args: this.buildVerbArgs(session.agent, session.directory, [
          "cancel",
          "--session",
          session.name
        ]),
        cwd: session.directory,
        ...(runtimeEnv != null ? { env: runtimeEnv } : {})
      }).catch(() => {
        // best-effort cancel
      });
      if (session.recoveryFence != null) {
        await this.resolveRecoveryFenceForStop(session);
      }
      const signalledChild = this.terminateActiveTurnProcess(params.name, "SIGTERM");
      if (signalledChild != null) {
        const forceKillTimer = setTimeout(() => {
          // Identity-guarded: if the SIGTERM'd child exited quickly and a new
          // turn already registered its own process under this session name,
          // this delayed SIGKILL must not hit the new turn's process.
          this.terminateActiveTurnProcess(params.name, "SIGKILL", signalledChild);
        }, 2_000);
        forceKillTimer.unref();
      }
      if (hadActiveTurn) {
        const drained = await this.waitForActiveTurnDrain(params.name);
        if (!drained) {
          throw new PuppenclawError(
            "QUIESCENCE_UNAVAILABLE",
            `Session ${params.name} did not drain after Stop.`
          );
        }
        runningReceipt = Object.values(this.deps.store.getTurnRequests(params.name)).find(
          (receipt) => receipt.state === "running"
        );
      }

      const nextSession: SessionInfo = {
        ...session,
        state: "stopped",
        lastActivity: nowIso(),
        lastStopReason: "stopped by user"
      };
      const stopPatch = (current: SessionInfo | null): SessionInfo => {
        const latest = current ?? nextSession;
        const stoppedAt = nowIso();
        return {
          ...withoutRecoveryFence(withoutFocusLease(latest)),
          state: "stopped",
          lastActivity: stoppedAt,
          lastStopReason: "stopped by user",
          ...(latest.activeTurn != null
            ? {
                activeTurn: {
                  ...latest.activeTurn,
                  state: "stopped",
                  updatedAt: stoppedAt,
                  completedAt: latest.activeTurn.completedAt ?? stoppedAt
                }
              }
            : {})
        };
      };
      const hasLocalKeyedExecution = this.keyedTurnExecutions.has(params.name);
      let persistedSession: SessionInfo | null;
      if (runningReceipt != null && !hasLocalKeyedExecution) {
        await this.deps.store.settleTurnRequestDuringReconciliation(
          params.name,
          runningReceipt.turnKey,
          runningReceipt.requestFingerprint,
          durableTurnError(
            new PuppenclawError(
              "TURN_ABORTED",
              `Turn ${runningReceipt.turnKey} was stopped by the operator.`
            )
          ),
          (current) => stopPatch(current)
        );
        persistedSession = this.deps.store.getSession(params.name);
      } else {
        persistedSession = await this.deps.store.patchSession(params.name, stopPatch);
      }
      if (!hadActiveTurn) {
        this.stopRequests.delete(params.name);
      }
      return textToolResult(`Stopped session ${params.name}.`, {
        session: persistedSession ?? nextSession
      });
    });
  }

  async resume(params: ResumeParams): Promise<ToolResult> {
    let capacityReserved = false;
    try {
      while (true) {
        const snapshot = this.requireSession(params.name);
        if (
          !capacityReserved &&
          !isConnectedSession(snapshot) &&
          !this.usesOneShotRuntime(snapshot)
        ) {
          capacityReserved = await this.ensureConnectedCapacity(snapshot.name);
        }
        const attempt = await this.withLifecycleLock(
          params.name,
          async (): Promise<{ retry: true } | { result: ToolResult }> => {
            this.deps.store.assertSessionMutable(params.name);
            const storedSession = this.requireSession(params.name);
            if (this.isTurnActive(storedSession) || storedSession.activeTurn?.state === "running") {
              throw new PuppenclawError(
                "TURN_ALREADY_RUNNING",
                `Session ${params.name} is currently running a turn and cannot be resumed.`
              );
            }
            if (
              !capacityReserved &&
              !isConnectedSession(storedSession) &&
              !this.usesOneShotRuntime(storedSession)
            ) {
              return { retry: true };
            }
            const reasoning = this.resolveSessionReasoning(storedSession);
            const session = reasoning.session;
            if (!this.usesOneShotRuntime(session)) {
              await this.ensureRuntimeSession({
                name: session.name,
                agent: session.agent,
                directory: session.directory,
                forceApply: true,
                // Resume is a reconnect, not a turn: keep it usable even when the
                // adapter no longer knows the pinned model. The failed set is not
                // remembered as applied, so the next start/send re-attempts it and
                // fails with MODEL_UNAVAILABLE before running anything.
                tolerateModelRejection: true,
                ...(session.model != null ? { model: session.model } : {}),
                ...(session.runtimeEffort != null ? { effort: session.runtimeEffort } : {}),
                ...(session.agent === "claude" ? { ultracode: session.effort === "ultracode" } : {}),
                ...(session.modelProvider != null ? { modelProvider: session.modelProvider } : {})
              });
            }
            const nextSession: SessionInfo = {
              ...session,
              state: "idle",
              warnings: dedupeWarnings([
                ...session.warnings,
                ...(reasoning.warning != null ? [reasoning.warning] : [])
              ])
            };
            await this.deps.store.upsertSession(nextSession);
            return {
              result: textToolResult(`Resumed session ${params.name}.`, {
                session: nextSession
              })
            };
          }
        );
        if ("result" in attempt) {
          return attempt.result;
        }
      }
    } finally {
      if (capacityReserved) {
        this.releaseCapacityReservation(params.name);
      }
    }
  }

  async suspend(params: SuspendParams): Promise<ToolResult> {
    return await this.withLifecycleLock(params.name, async () => {
      this.deps.store.assertSessionMutable(params.name);
      const session = this.requireSession(params.name);
      if (this.isTurnActive(session)) {
        throw new PuppenclawError(
          "TURN_ALREADY_RUNNING",
          `Session ${params.name} is currently running a turn and cannot be suspended.`
        );
      }
      if (session.state === "suspended" || isTerminalSession(session)) {
        return textToolResult(`Session ${params.name} is not connected.`, {
          session
        });
      }
      const nextSession = await this.suspendTrackedSession(session, "suspended by user");
      return textToolResult(`Suspended session ${params.name}.`, {
        session: nextSession
      });
    });
  }

  async focus(params: FocusParams): Promise<ToolResult> {
    return await this.withLifecycleLock(params.name, async () => {
      this.deps.store.assertSessionMutable(params.name);
      const session = this.requireSession(params.name);
      const ttlMs = params.ttlMs ?? DEFAULT_FOCUS_LEASE_MS;
      const nextSession: SessionInfo = {
        ...session,
        focusedUntil: new Date(Date.now() + ttlMs).toISOString()
      };
      await this.deps.store.upsertSession(nextSession);
      return textToolResult(`Focused session ${params.name}.`, {
        session: nextSession
      });
    });
  }

  async unfocus(params: UnfocusParams): Promise<ToolResult> {
    return await this.withLifecycleLock(params.name, async () => {
      this.deps.store.assertSessionMutable(params.name);
      const session = this.requireSession(params.name);
      const nextSession = withoutFocusLease(session);
      await this.deps.store.upsertSession(nextSession);
      return textToolResult(`Unfocused session ${params.name}.`, {
        session: nextSession
      });
    });
  }

  async fork(params: ForkParams): Promise<ToolResult> {
    const claimTarget = await this.withAdmissionLock(async () => {
      if (this.forkTargetClaims.has(params.target)) {
        throw new PuppenclawError(
          "FORK_TARGET_CLAIMED",
          `Target session ${params.target} is already being created by another fork.`
        );
      }
      this.forkTargetClaims.add(params.target);
      return true;
    });
    try {
      while (true) {
        await this.activeTurnCompletion.get(params.source)?.promise;
        const attempt = await this.withLifecycleLocks(
          [params.source, params.target],
          async (): Promise<{ startParams: StartParams } | { wait: Promise<void> }> => {
            const racedCompletion = this.activeTurnCompletion.get(params.source)?.promise;
            if (racedCompletion != null) {
              return { wait: racedCompletion };
            }
            return {
              startParams: await this.prepareForkWithLifecycleLocksHeld(params)
            };
          }
        );
        if ("wait" in attempt) {
          await attempt.wait;
          continue;
        }
        try {
          const result = await this.startTurn(attempt.startParams);
          return textToolResult(`Forked ${params.source} into ${params.target}.`, result.details);
        } finally {
          this.releaseSessionTurn(params.target);
        }
      }
    } finally {
      if (claimTarget) {
        this.forkTargetClaims.delete(params.target);
      }
    }
  }

  private async prepareForkWithLifecycleLocksHeld(params: ForkParams): Promise<StartParams> {
    this.deps.store.assertSessionMutable(params.source);
    this.deps.store.assertSessionMutable(params.target);
    if (params.source === params.target) {
      throw new PuppenclawError(
        "SESSION_CONFLICT",
        "A fork target must differ from its source session."
      );
    }
    if (this.deps.store.getSession(params.target) != null) {
      throw new PuppenclawError(
        "SESSION_EXISTS",
        `Target session ${params.target} already exists.`
      );
    }
    // Re-read only after the source turn is quiet and both stable-order locks
    // are held, so the branch includes every durably completed source entry.
    const source = this.requireSession(params.source);
    const transcriptText = source.transcript
      .map((entry) => `${entry.role.toUpperCase()}: ${entry.text}`)
      .join("\n\n");
    const startParams: StartParams = {
      agent: source.agent,
      name: params.target,
      directory: source.directory,
      task: [
        `This is a fork of session ${source.name}.`,
        "Treat the following transcript as prior context for the new branch.",
        transcriptText
      ].join("\n\n"),
      permissionMode: source.permissionMode,
      effort: params.effort ?? source.effort,
      planningProfile: source.planningProfile,
      model: params.model ?? source.model,
      contextFiles: [],
      skills: source.skills ?? []
    };
    if (source.modelProviderId != null) {
      startParams.modelProviderId = source.modelProviderId;
    }
    if (source.modelProvider != null) {
      startParams.modelProvider = source.modelProvider;
    }
    const ownerKey = this.deps.store.getSessionOwner(source.name);
    if (ownerKey != null) {
      startParams.ownerKey = ownerKey;
    }
    await this.enterSessionTurnAfterLifecycleLock(params.target, undefined);
    return startParams;
  }

  async listSkills(): Promise<ToolResult> {
    return jsonToolResult(
      {
        skills: await this.listAvailableSkills()
      },
      "Available Orchestrator skills"
    );
  }

  async status(params: StatusParams = {}): Promise<ToolResult> {
    if (params.name == null) {
      const sessions = await Promise.all(
        this.deps.store.listSessions().map(async (session) => {
          const reconciled = await this.reconcileVisibleSession(session);
          return {
            ...reconciled.session,
            turn: reconciled.turn
          };
        })
      );
      return jsonToolResult(
        {
          sessions
        },
        "Tracked Orchestrator sessions"
      );
    }
    const stored = this.requireSession(params.name);
    const activeQuiescence = this.deps.store.getQuiescence(stored.name);
    // A fenced session has no live runtime to probe; report the quiesced view
    // instead of running process-identity reconciliation against it.
    const reconciled =
      activeQuiescence != null
        ? { session: this.decorateVisibleSession(stored), turn: null }
        : await this.reconcileVisibleSession(stored);
    const session = reconciled.session;
    const runtimeStatus =
      activeQuiescence != null
        ? { exists: false, status: "quiesced" }
        : await this.getRuntimeStatus({
            name: session.name,
            agent: session.agent,
            directory: session.directory,
            ...(session.modelProvider != null ? { modelProvider: session.modelProvider } : {})
          });
    const details = {
      session,
      runtime: runtimeStatus,
      ...(reconciled.turn != null ? { turn: reconciled.turn } : {}),
      ...(activeQuiescence != null
        ? { lifecycle: { quiesced: true, epoch: activeQuiescence.epoch } }
        : {})
    };
    return jsonToolResult(details, `Status for ${params.name}`);
  }

  async output(params: StatusParams): Promise<ToolResult> {
    if (params.name == null) {
      throw new PuppenclawError("MISSING_SESSION", "Session name is required.");
    }
    const session = this.requireSession(params.name);
    const reconciled = await this.reconcileVisibleSession(session);
    const active = this.activeTurnOutputs.get(params.name);
    const runningActive = active != null && !active.complete ? active : undefined;
    const latestTranscriptOutput = [...session.transcript]
      .reverse()
      .find(
        (entry) =>
          (entry.role === "assistant" || entry.role === "status") && entry.text.trim().length > 0
      );
    const activeHasText = active != null && active.text.trim().length > 0;
    const useActive =
      runningActive != null ||
      (activeHasText &&
        (latestTranscriptOutput == null ||
          Date.parse(active.updatedAt) >= Date.parse(latestTranscriptOutput.createdAt) - 5_000 ||
          session.state === "failed"));
    const text = useActive
      ? (active?.text ?? "")
      : (latestTranscriptOutput?.text ?? active?.text ?? "");
    return jsonToolResult(
      {
        session: reconciled.session,
        turn: reconciled.turn,
        output: {
          text,
          chars: text.length,
          source:
            useActive && active != null
              ? "active-turn"
              : latestTranscriptOutput != null
                ? "transcript"
                : "none",
          // Turn provenance: consumers attributing this text to a specific
          // turn must be able to reject text that predates the turn they
          // dispatched, instead of resurrecting an older reply.
          turnId:
            useActive && active != null
              ? (this.activeTurnIds.get(params.name) ?? reconciled.session.activeTurn?.id ?? null)
              : (latestTranscriptOutput?.turnId ?? null),
          withinActiveTurn:
            useActive && active != null
              ? true
              : latestTranscriptOutput != null && reconciled.session.activeTurn != null
                ? latestTranscriptOutput.turnId != null
                  ? latestTranscriptOutput.turnId === reconciled.session.activeTurn.id
                  : Date.parse(latestTranscriptOutput.createdAt) >=
                    Date.parse(reconciled.session.activeTurn.startedAt)
                : false,
          startedAt: useActive ? (active?.startedAt ?? null) : null,
          updatedAt: useActive
            ? (active?.updatedAt ?? null)
            : (latestTranscriptOutput?.createdAt ?? null),
          complete: runningActive?.complete ?? session.state !== "running"
        }
      },
      `Output for ${params.name}`
    );
  }

  async cost(params: CostParams = {}): Promise<ToolResult> {
    if (params.name == null) {
      return this.usageRollup(params);
    }
    const session = this.deps.store.getSession(params.name);
    if (session == null) {
      // Purged/GC'd sessions keep their turns in the durable usage ledger even
      // though the registry record is gone. Cost is ledger-scoped, not
      // registry-scoped: serve those turns instead of failing, so one-shot
      // sessions stay billable after cleanup. Names absent from both the
      // registry and the ledger still fail with NO_SESSION.
      return this.ledgerOnlyCost(params.name, params);
    }
    const totals = this.deps.ledger?.perSessionTotals(session.name) ?? null;
    const history = this.deps.ledger?.perSessionHistory(session.name, params.limit ?? 20) ?? [];
    const provider = deriveUsageProvider(session);
    const model = deriveUsageModel(session);
    const contextSnapshot =
      session.tokenUsage?.used != null && session.tokenUsage?.size != null
        ? ` Context: ${formatTokenCount(session.tokenUsage.used)}/${formatTokenCount(session.tokenUsage.size)}.`
        : "";
    const summary =
      totals != null && totals.turns > 0
        ? `Usage for session ${session.name} (${provider} ${model}): ${totals.turns} turn${
            totals.turns === 1 ? "" : "s"
          }, ${formatUsageLine(totals.usage)}.${contextSnapshot}`
        : `Usage for session ${session.name}: no recorded token counters yet.${contextSnapshot}`;
    return textToolResult(summary, {
      name: session.name,
      provider,
      model,
      lastCall: session.tokenUsage ?? null,
      totals,
      turns: totals?.turns ?? 0,
      history,
      pricing: null,
      note: "Orchestrator records token counters when the ACP runtime emits them. It does not infer currency pricing."
    });
  }

  /**
   * Serves per-session cost for a session that is no longer in the registry
   * straight from the durable usage ledger. The payload mirrors the
   * live-session shape field for field — per-turn `history` entries keep their
   * ledger ids, so downstream reconciliation dedupes exactly as before — with
   * two documented deviations: `lastCall` is always null (the context-window
   * snapshot lives only on the registry record) and provider/model are taken
   * from the most recent ledger turn instead of the session record. The
   * additive `ledgerOnly` marker identifies the fallback.
   */
  private ledgerOnlyCost(name: string, params: CostParams): ToolResult {
    const totals = this.deps.ledger?.perSessionTotals(name);
    if (totals == null || totals.turns === 0) {
      throw new PuppenclawError("NO_SESSION", `Unknown session ${name}.`);
    }
    const history = this.deps.ledger?.perSessionHistory(name, params.limit ?? 20) ?? [];
    // A turn's subagent rows share its timestamp; the session model is the main row's.
    const latest = history.find((entry) => entry.role !== "subagent") ?? history[0];
    const provider = latest?.provider ?? "unknown";
    const model = latest?.model ?? "unknown";
    const summary = `Usage for purged session ${name} (${provider} ${model}): ${totals.turns} turn${
      totals.turns === 1 ? "" : "s"
    }, ${formatUsageLine(totals.usage)}. Served from the durable usage ledger.`;
    return textToolResult(summary, {
      name,
      provider,
      model,
      lastCall: null,
      totals,
      turns: totals.turns,
      history,
      pricing: null,
      ledgerOnly: true,
      note: "Orchestrator records token counters when the ACP runtime emits them. It does not infer currency pricing."
    });
  }

  private usageRollup(params: CostParams): ToolResult {
    const ledger = this.deps.ledger;
    const scope = params.since != null ? `since ${params.since}` : "all recorded sessions";
    const note =
      "Orchestrator records token counters when the ACP runtime emits them. It does not infer currency pricing.";
    if (ledger == null) {
      return textToolResult(
        `Usage rollup (${scope}): no usage ledger is configured, so no token counters are recorded.`,
        {
          rollup: [],
          totals: null,
          since: params.since ?? null,
          pricing: null,
          note
        }
      );
    }
    const rollup = ledger.perModelRollup(params.since);
    const totals = ledger.grandTotals(params.since);
    const lines = rollup.map(
      (entry) =>
        `${entry.provider}/${entry.model}: ${entry.turns} turn${entry.turns === 1 ? "" : "s"}, ${formatUsageLine(entry.usage)}`
    );
    const summary =
      totals.turns > 0
        ? [
            `Usage rollup (${scope}):`,
            ...lines,
            `TOTAL: ${totals.turns} turn${totals.turns === 1 ? "" : "s"}, ${formatUsageLine(totals.usage)}`
          ].join("\n")
        : `Usage rollup (${scope}): no recorded token counters yet.`;
    return textToolResult(summary, {
      rollup,
      totals,
      since: params.since ?? null,
      pricing: null,
      note
    });
  }

  async purge(params: StopParams): Promise<ToolResult> {
    return await this.withLifecycleLock(params.name, async () => {
      const existingReservation = this.deps.store.getQuiescence(params.name);
      const locallyTrackedTurn =
        this.activeTurns.has(params.name) ||
        this.activeTurnProcesses.has(params.name) ||
        Object.values(this.deps.store.getTurnRequests(params.name)).some(
          (receipt) => receipt.state === "running"
        );
      if (this.deps.store.getSession(params.name) == null) {
        if (existingReservation != null && existingReservation.purpose === "purge") {
          await this.deps.store.releaseQuiescence(params.name, existingReservation.epoch);
          this.stopRequests.delete(params.name);
          return textToolResult(`Session ${params.name} was already purged.`, {
            sessionName: params.name,
            purged: true,
            alreadyAbsent: true,
            quiescenceEpoch: existingReservation.epoch,
            transientFence: true
          });
        }
        if (!locallyTrackedTurn) {
          throw new PuppenclawError("NO_SESSION", `Unknown session ${params.name}.`, {
            name: params.name,
            transientFence: existingReservation == null
          });
        }
      }
      const reservation = await this.deps.store.reserveQuiescence(params.name, "purge");
      const epoch = reservation.epoch;
      await this.deps.advanced?.closeTurn(params.name);
      const session = this.deps.store.getSession(params.name);
      if (session != null) {
        await this.closeQuiescedRuntime(session, epoch, { locallyTrackedTurn });
      } else {
        const startedSession = await this.drainUnknownQuiescedTurn(params.name, epoch);
        if (startedSession != null) {
          await this.closeQuiescedRuntime(startedSession, epoch, {
            locallyTrackedTurn: true
          });
        }
      }
      await this.deps.advanced?.purge(params.name);
      await purgeSessionDiagnostics(this.deps.store.rootDir, params.name);
      await this.deps.store.removeSession(params.name);
      this.deps.outputRouter.clear(params.name);
      this.activeTurnOutputs.delete(params.name);
      this.activeTurnProcesses.delete(params.name);
      this.deps.statistics?.forgetRuntime(params.name);
      this.stopRequests.delete(params.name);
      if (reservation.purpose === "purge") {
        await this.deps.store.releaseQuiescence(params.name, epoch);
      }
      return textToolResult(`Purged session ${params.name}.`, {
        sessionName: params.name,
        purged: true,
        quiescenceEpoch: epoch,
        transientFence: reservation.purpose === "purge"
      });
    });
  }

  async quiesce(params: QuiesceParams): Promise<ToolResult> {
    return await this.withLifecycleLock(params.name, async () => {
      const reservation = await this.deps.store.reserveQuiescence(params.name, "external");
      const epoch = reservation.epoch;
      await this.deps.advanced?.closeTurn(params.name);
      const locallyTrackedTurn =
        this.activeTurns.has(params.name) || this.activeTurnProcesses.has(params.name);
      const session = this.deps.store.getSession(params.name);
      if (session != null) {
        await this.closeQuiescedRuntime(session, epoch, { locallyTrackedTurn });
      } else if (locallyTrackedTurn) {
        const startedSession = await this.drainUnknownQuiescedTurn(params.name, epoch);
        if (startedSession != null) {
          await this.closeQuiescedRuntime(startedSession, epoch, {
            locallyTrackedTurn: true
          });
        }
      }
      return textToolResult(`Quiesced session ${params.name}.`, {
        ...(session != null ? { session: this.decorateVisibleSession(session) } : {}),
        reservation: {
          name: params.name,
          epoch
        },
        quiescenceEpoch: epoch,
        runtimeClosed: true
      });
    });
  }

  async releaseQuiescence(params: QuiescenceReleaseParams): Promise<ToolResult> {
    return await this.withLifecycleLock(params.name, async () => {
      await this.deps.store.releaseQuiescence(params.name, params.epoch);
      this.stopRequests.delete(params.name);
      return textToolResult(`Released quiescence for session ${params.name}.`, {
        reservation: {
          name: params.name,
          epoch: params.epoch
        },
        quiescenceEpoch: params.epoch,
        released: true
      });
    });
  }

  async gc(): Promise<void> {
    const now = Date.now();
    const ttlMs = this.deps.config.sessionTtlMinutes * 60_000;
    for (const session of this.deps.store.listSessions()) {
      if (!["failed", "completed", "stopped"].includes(session.state)) {
        continue;
      }
      // The stored state/lastActivity are only updated when a turn FINISHES,
      // so a session with an in-flight turn can look terminal and expired
      // here. Never close/remove a session while a turn is running: consult
      // the in-memory turn lock and the live turn-process registry.
      if (this.activeTurns.has(session.name) || this.activeTurnProcesses.has(session.name)) {
        continue;
      }
      const ageMs = now - Date.parse(session.lastActivity);
      if (!Number.isFinite(ageMs) || ageMs < ttlMs) {
        continue;
      }
      await this.purge({ name: session.name }).catch((error) => {
        this.deps.logger.warn(
          `Unable to purge expired session ${session.name}: ${ensureError(error).message}`
        );
      });
    }
  }

  /** Reconcile persisted turns before accepting any new work. */
  async reconcilePersistedSessions(): Promise<void> {
    const names = new Set([
      ...this.deps.store.listSessions().map((session) => session.name),
      ...this.deps.store.listRunningTurnRequests().map((receipt) => receipt.sessionName)
    ]);
    for (const name of names) {
      await this.withLifecycleLock(name, async () => {
        const stored = this.deps.store.getSession(name);
        const receipt = Object.values(this.deps.store.getTurnRequests(name)).find(
          (candidate) => candidate.state === "running"
        );
        const interruptedOutcome = (reason: string): TurnRequestErrorOutcome =>
          durableTurnError(
            new PuppenclawError(
              "TURN_INTERRUPTED_RESTART",
              `Turn for session ${name} cannot be replayed after daemon restart: ${reason}`
            )
          );

        // A durable claim is written before any provider process can launch.
        // If restart finds no published active turn, it can prove that this
        // daemon never dispatched the provider request and settle the key as
        // interrupted. The durable error remains replayable and prevents an
        // ambiguous client retry from becoming new work.
        if (
          receipt != null &&
          (stored == null ||
            receipt.activeTurnId == null ||
            stored.activeTurn?.id !== receipt.activeTurnId)
        ) {
          await this.deps.store.settleTurnRequestDuringReconciliation(
            name,
            receipt.turnKey,
            receipt.requestFingerprint,
            interruptedOutcome("no matching active-turn publication was persisted"),
            stored == null
              ? undefined
              : (current) => ({
                  ...withoutRecoveryFence(current),
                  state: current.state === "stopped" ? "stopped" : "failed",
                  lastActivity: nowIso(),
                  lastError:
                    current.lastError ??
                    "Durable turn claim was interrupted before active-turn publication."
                })
          );
          this.deps.logger.warn(
            `Session ${name} had an unpublished durable turn claim; settled it as interrupted at startup.`
          );
          return;
        }
        if (stored == null) {
          return;
        }

        // A terminal active turn with an unsettled receipt can result from a
        // crash or operator stop during final persistence. Never synthesize a
        // success; retain an explicit replayable interruption instead.
        if (receipt != null && stored.activeTurn?.state !== "running") {
          await this.deps.store.settleTurnRequestDuringReconciliation(
            name,
            receipt.turnKey,
            receipt.requestFingerprint,
            interruptedOutcome(`the published turn is already ${stored.activeTurn?.state ?? "absent"}`)
          );
          return;
        }

        if (
          stored.state !== "running" &&
          stored.activeTurn?.state !== "running" &&
          stored.recoveryFence == null
        ) {
          return;
        }
        const reconciled = await this.reconcileVisibleSession(stored);
        try {
          if (reconciled.turn.classification === "orphaned") {
            const patch = (current: SessionInfo): SessionInfo =>
              current.activeTurn?.id !== stored.activeTurn?.id
                ? current
                : {
                    ...withoutRecoveryFence(reconciled.session),
                    lastStopReason: "Interrupted by daemon restart"
                  };
            if (receipt != null) {
              await this.deps.store.settleTurnRequestDuringReconciliation(
                name,
                receipt.turnKey,
                receipt.requestFingerprint,
                interruptedOutcome("the recorded provider process is definitely gone"),
                patch
              );
            } else {
              await this.patchSessionDuringReconciliation(name, patch);
            }
            this.deps.logger.warn(
              `Session ${name} had a persisted active turn whose process is gone; marked failed at startup.`
            );
            return;
          }

          const recoveryFence: SessionRecoveryFence = stored.recoveryFence ?? {
            reason:
              stored.activeTurn == null
                ? "missing-turn-metadata"
                : reconciled.turn.processAlive === true
                  ? "restart-survivor"
                  : "unverified-process",
            detectedAt: nowIso(),
            ...(reconciled.turn.pid != null ? { pid: reconciled.turn.pid } : {}),
            ...(reconciled.turn.processGroupId != null
              ? { processGroupId: reconciled.turn.processGroupId }
              : {}),
            ...(stored.activeTurn?.processStartIdentity != null
              ? { processStartIdentity: stored.activeTurn.processStartIdentity }
              : {})
          };
          await this.patchSessionDuringReconciliation(name, (current) =>
            current.activeTurn?.id !== stored.activeTurn?.id
              ? current
              : {
                  ...current,
                  recoveryFence
                }
          );
          this.deps.logger.warn(
            `Session ${name} may still have restart-surviving work; fenced against new turns.`
          );
        } catch (error) {
          this.deps.logger.warn(
            `Unable to reconcile persisted session ${name} at startup: ${ensureError(error).message}`
          );
        }
      });
    }
  }

  private async patchSessionDuringReconciliation(
    name: string,
    patch: (current: SessionInfo) => SessionInfo
  ): Promise<SessionInfo | null> {
    const reservation = this.deps.store.getQuiescence(name);
    if (reservation != null) {
      return await this.deps.store.patchQuiescedSession(name, reservation.epoch, patch);
    }
    return await this.deps.store.patchSession(name, (current) =>
      current == null ? null : patch(current)
    );
  }

  private async withSessionTurnLock<T>(
    name: string,
    lifecycleEpoch: number | undefined,
    admissionGeneration: number,
    run: () => Promise<T>
  ): Promise<T> {
    await this.withLifecycleLock(name, async () => {
      this.assertTurnGeneration(name, admissionGeneration);
      await this.enterSessionTurnAfterLifecycleLock(name, lifecycleEpoch);
    });
    try {
      return await run();
    } finally {
      this.releaseSessionTurn(name);
    }
  }

  private async runSessionTurn(
    name: string,
    lifecycleEpoch: number | undefined,
    admissionGeneration: number,
    idempotency:
      | {
          operation: "start" | "send";
          turnKey: string;
          requestFingerprint: string;
        }
      | undefined,
    run: () => Promise<ToolResult>
  ): Promise<ToolResult> {
    if (idempotency == null) {
      return await this.withSessionTurnLock(name, lifecycleEpoch, admissionGeneration, run);
    }

    const disposition = await this.withLifecycleLock(name, async () => {
      this.assertTurnGeneration(name, admissionGeneration);
      const existing = this.deps.store.getTurnRequest(name, idempotency.turnKey);
      if (existing != null) {
        if (
          existing.operation !== idempotency.operation ||
          existing.requestFingerprint !== idempotency.requestFingerprint
        ) {
          throw new PuppenclawError(
            "TURN_KEY_CONFLICT",
            `Turn key ${idempotency.turnKey} was already used for a different request in session ${name}.`,
            { name, turnKey: idempotency.turnKey }
          );
        }
        if (existing.state === "settled") {
          return { kind: "replay" as const, receipt: existing };
        }
        const inFlight = this.keyedTurnExecutions.get(name);
        if (
          inFlight?.turnKey === idempotency.turnKey &&
          inFlight.requestFingerprint === idempotency.requestFingerprint
        ) {
          return { kind: "wait" as const, promise: inFlight.promise };
        }
        throw new PuppenclawError(
          "TURN_REPLAY_UNAVAILABLE",
          `Turn key ${idempotency.turnKey} is durably active or ambiguous after restart; refusing to launch it again.`,
          { name, turnKey: idempotency.turnKey }
        );
      }

      await this.enterSessionTurnAfterLifecycleLock(name, lifecycleEpoch);
      let resolveExecution!: (result: ToolResult) => void;
      let rejectExecution!: (error: unknown) => void;
      const promise = new Promise<ToolResult>((resolve, reject) => {
        resolveExecution = resolve;
        rejectExecution = reject;
      });
      void promise.catch(() => undefined);
      const execution: KeyedTurnExecution = {
        turnKey: idempotency.turnKey,
        requestFingerprint: idempotency.requestFingerprint,
        promise,
        resolve: resolveExecution,
        reject: rejectExecution
      };
      try {
        await this.deps.store.claimTurnRequest({
          sessionName: name,
          turnKey: idempotency.turnKey,
          operation: idempotency.operation,
          requestFingerprint: idempotency.requestFingerprint
        });
        this.keyedTurnExecutions.set(name, execution);
      } catch (error) {
        this.releaseSessionTurn(name);
        throw error;
      }
      return { kind: "execute" as const, execution };
    });

    if (disposition.kind === "replay") {
      return this.replayTurnRequest(disposition.receipt);
    }
    if (disposition.kind === "wait") {
      await disposition.promise.catch(() => undefined);
      const receipt = this.deps.store.getTurnRequest(name, idempotency.turnKey);
      if (receipt?.state === "settled") {
        return this.replayTurnRequest(receipt);
      }
      throw new PuppenclawError(
        "TURN_REPLAY_UNAVAILABLE",
        `Turn key ${idempotency.turnKey} did not produce a durable replay outcome; refusing to launch it again.`,
        { name, turnKey: idempotency.turnKey }
      );
    }

    try {
      await run();
      const durableReceipt = this.deps.store.getTurnRequest(name, idempotency.turnKey);
      if (durableReceipt?.state !== "settled" || durableReceipt.outcome == null) {
        throw new PuppenclawError(
          "TURN_RECEIPT_NOT_SETTLED",
          `Turn key ${idempotency.turnKey} completed without a durable outcome.`
        );
      }
      if (durableReceipt.outcome.kind === "error") {
        const durableError = new PuppenclawError(
          durableReceipt.outcome.code,
          durableReceipt.outcome.message,
          {
            ...durableReceipt.outcome.details,
            ...(durableReceipt.outcome.retryable != null
              ? { retryable: durableReceipt.outcome.retryable }
              : {}),
            turnReceipt: { turnKey: idempotency.turnKey, state: "accepted" }
          }
        );
        disposition.execution.reject(durableError);
        throw durableError;
      }
      const accepted = toolResultFromTurnOutcome(
        durableReceipt.outcome,
        idempotency.turnKey,
        "accepted"
      );
      disposition.execution.resolve(accepted);
      return accepted;
    } catch (error) {
      let thrownError: unknown = error;
      const receipt = this.deps.store.getTurnRequest(name, idempotency.turnKey);
      if (receipt?.state === "settled" && receipt.outcome?.kind === "error") {
        thrownError = new PuppenclawError(receipt.outcome.code, receipt.outcome.message, {
          ...receipt.outcome.details,
          ...(receipt.outcome.retryable != null
            ? { retryable: receipt.outcome.retryable }
            : {}),
          turnReceipt: { turnKey: idempotency.turnKey, state: "accepted" }
        });
      } else if (receipt?.state === "running") {
        const outcome = durableTurnError(error);
        const settled = await this.deps.store
          .settleTurnRequestDuringReconciliation(
            name,
            idempotency.turnKey,
            idempotency.requestFingerprint,
            outcome,
            (current) => {
              if (current.state === "stopped") {
                return current;
              }
              const failedAt = nowIso();
              const activeTurn =
                current.activeTurn?.turnKey === idempotency.turnKey &&
                current.activeTurn.requestFingerprint === idempotency.requestFingerprint &&
                current.activeTurn.state === "running"
                  ? {
                      ...current.activeTurn,
                      state: "failed" as const,
                      updatedAt: failedAt,
                      completedAt: failedAt,
                      error: outcome.message,
                      failureCode: outcome.code,
                      ...((outcome.retryable ?? outcome.details?.retryable) != null
                        ? { retryable: (outcome.retryable ?? outcome.details?.retryable) as boolean }
                        : {})
                    }
                  : current.activeTurn;
              return {
                ...current,
                state: "failed",
                lastActivity: failedAt,
                lastError: outcome.message,
                failureCode: outcome.code,
                ...((outcome.retryable ?? outcome.details?.retryable) != null
                  ? { retryable: (outcome.retryable ?? outcome.details?.retryable) as boolean }
                  : {}),
                ...(activeTurn != null ? { activeTurn } : {})
              };
            }
          )
          .then(
            () => true,
            (settleError) => {
              this.deps.logger.error(
                `Unable to settle failed turn receipt ${idempotency.turnKey} for ${name}: ${ensureError(settleError).message}`
              );
              return false;
            }
          );
        if (settled) {
          thrownError = new PuppenclawError(outcome.code, outcome.message, {
            ...outcome.details,
            turnReceipt: { turnKey: idempotency.turnKey, state: "accepted" }
          });
        }
      }
      disposition.execution.reject(thrownError);
      throw thrownError;
    } finally {
      if (this.keyedTurnExecutions.get(name) === disposition.execution) {
        this.keyedTurnExecutions.delete(name);
      }
      this.releaseSessionTurn(name);
    }
  }

  private replayTurnRequest(receipt: TurnRequestReceipt): ToolResult {
    if (receipt.state !== "settled" || receipt.outcome == null) {
      throw new PuppenclawError(
        "TURN_REPLAY_UNAVAILABLE",
        `Turn key ${receipt.turnKey} has no durable terminal outcome; refusing to launch it again.`,
        { name: receipt.sessionName, turnKey: receipt.turnKey }
      );
    }
    if (receipt.outcome.kind === "error") {
      return throwDurableTurnError(receipt.outcome, receipt.turnKey, "replayed");
    }
    return toolResultFromTurnOutcome(receipt.outcome, receipt.turnKey, "replayed");
  }

  private assertTurnGeneration(name: string, expected: number): void {
    const current = this.deps.store.getTurnGeneration(name);
    if (current !== expected) {
      throw new PuppenclawError(
        "STALE_TURN_GENERATION",
        `Session ${name} was purged while this turn request was waiting; refusing to resurrect it.`,
        { name, requestedGeneration: expected, currentGeneration: current }
      );
    }
  }

  private async enterSessionTurnAfterLifecycleLock(
    name: string,
    lifecycleEpoch: number | undefined
  ): Promise<void> {
    const unsettledReceipt = Object.values(this.deps.store.getTurnRequests(name)).find(
      (receipt) => receipt.state === "running"
    );
    if (unsettledReceipt != null) {
      throw new PuppenclawError(
        "TURN_REPLAY_UNAVAILABLE",
        `Session ${name} has active or ambiguous turn key ${unsettledReceipt.turnKey}; refusing another dispatch.`,
        { name, turnKey: unsettledReceipt.turnKey }
      );
    }
    if (this.activeTurns.has(name)) {
      throw new PuppenclawError(
        "TURN_ALREADY_RUNNING",
        `Session ${name} is already running a turn.`
      );
    }
    await this.assertRecoveryFenceReleased(name);
    await this.deps.store.enterLifecycleTurn(name, lifecycleEpoch);
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    this.activeTurnCompletion.set(name, {
      promise: completion,
      resolve: resolveCompletion
    });
    this.activeTurns.add(name);
    this.stopRequests.delete(name);
  }

  private releaseSessionTurn(name: string): void {
    this.activeTurns.delete(name);
    this.releaseCapacityReservation(name);
    const completion = this.activeTurnCompletion.get(name);
    this.activeTurnCompletion.delete(name);
    completion?.resolve();
  }

  private async withLifecycleLock<T>(name: string, run: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTails.get(name) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(run);
    const tail = operation.then(
      () => undefined,
      () => undefined
    );
    this.lifecycleTails.set(name, tail);
    try {
      return await operation;
    } finally {
      if (this.lifecycleTails.get(name) === tail) {
        this.lifecycleTails.delete(name);
      }
    }
  }

  private async withAdmissionLock<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.admissionTail.catch(() => undefined).then(run);
    this.admissionTail = operation.then(
      () => undefined,
      () => undefined
    );
    return await operation;
  }

  private async withLifecycleLocks<T>(names: readonly string[], run: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(names)].sort((left, right) => left.localeCompare(right));
    const acquire = async (index: number): Promise<T> => {
      const name = ordered[index];
      if (name == null) {
        return await run();
      }
      return await this.withLifecycleLock(name, async () => await acquire(index + 1));
    };
    return await acquire(0);
  }

  private async assertRecoveryFenceReleased(name: string): Promise<void> {
    const session = this.deps.store.getSession(name);
    if (session?.recoveryFence == null) {
      return;
    }
    if (await this.isRecoveredProcessDefinitelyGone(session.recoveryFence)) {
      const warning = "Restart-surviving turn termination was proved before the next dispatch.";
      await this.deps.store.patchSession(name, (current) =>
        current?.recoveryFence == null
          ? current
          : {
              ...withoutRecoveryFence(current),
              state: current.state === "running" ? "failed" : current.state,
              lastError: current.lastError ?? warning,
              lastStopReason: current.lastStopReason ?? "Interrupted by daemon restart",
              warnings: dedupeWarnings([...current.warnings, warning]),
              ...(current.activeTurn?.state === "running"
                ? {
                    activeTurn: {
                      ...current.activeTurn,
                      state: "orphaned",
                      updatedAt: nowIso(),
                      completedAt: nowIso(),
                      error: current.activeTurn.error ?? warning
                    }
                  }
                : {})
            }
      );
      return;
    }
    throw new PuppenclawError(
      "RECOVERY_FENCE_ACTIVE",
      `Session ${name} is fenced because work may have survived a manager restart. Stop the session and prove termination before starting another turn.`,
      { name, recoveryFence: session.recoveryFence }
    );
  }

  private async resolveRecoveryFenceForStop(session: SessionInfo): Promise<void> {
    const fence = session.recoveryFence;
    if (fence == null || (await this.isRecoveredProcessDefinitelyGone(fence))) {
      return;
    }

    if (
      process.platform === "linux" &&
      fence.pid != null &&
      fence.processStartIdentity != null
    ) {
      const deadline = Date.now() + RECOVERY_FENCE_TERMINATION_TIMEOUT_MS;
      const escalationAt = Date.now() + Math.floor(RECOVERY_FENCE_TERMINATION_TIMEOUT_MS / 2);
      while (Date.now() < deadline) {
        if (await this.isRecoveredProcessDefinitelyGone(fence)) {
          return;
        }
        await this.signalRecoveredProcess(
          fence,
          Date.now() >= escalationAt ? "SIGKILL" : "SIGTERM"
        );
        await sleep(QUIESCENCE_POLL_MS);
      }
      if (await this.isRecoveredProcessDefinitelyGone(fence)) {
        return;
      }
    }

    if (!this.usesOneShotRuntime(session)) {
      const runtimeEnv = this.modelProviderRuntimeEnv(session.modelProvider, session.name);
      await this.runControlCommand({
        args: this.buildVerbArgs(session.agent, session.directory, [
          "sessions",
          "close",
          session.name
        ]),
        cwd: session.directory,
        allowNoSession: true,
        timeoutMs: QUIESCENCE_CONTROL_TIMEOUT_MS,
        ...(runtimeEnv != null ? { env: runtimeEnv } : {})
      }).catch(() => undefined);
      const deadline = Date.now() + RECOVERY_FENCE_TERMINATION_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const status = await this.getRuntimeStatus({
          name: session.name,
          agent: session.agent,
          directory: session.directory,
          timeoutMs: QUIESCENCE_CONTROL_TIMEOUT_MS,
          ...(session.modelProvider != null ? { modelProvider: session.modelProvider } : {})
        }).catch(() => ({ exists: true }));
        if (!status.exists) {
          return;
        }
        await sleep(QUIESCENCE_POLL_MS);
      }
    }

    throw new PuppenclawError(
      "RECOVERY_FENCE_ACTIVE",
      `Termination of restart-surviving work for session ${session.name} could not be proved; the recovery fence remains active.`,
      { name: session.name, recoveryFence: fence }
    );
  }

  private async isRecoveredProcessDefinitelyGone(fence: SessionRecoveryFence): Promise<boolean> {
    if (process.platform !== "linux" || fence.pid == null) {
      return false;
    }
    const observed = await readLinuxProcessIdentity(fence.pid);
    if (observed == null) {
      return !pidMayExist(fence.pid);
    }
    return (
      fence.processStartIdentity != null &&
      observed.processStartIdentity !== fence.processStartIdentity
    );
  }

  private async signalRecoveredProcess(
    fence: SessionRecoveryFence,
    signal: NodeJS.Signals
  ): Promise<void> {
    if (fence.pid == null || fence.processStartIdentity == null) {
      return;
    }
    const observed = await readLinuxProcessIdentity(fence.pid);
    if (observed?.processStartIdentity !== fence.processStartIdentity) {
      return;
    }
    try {
      process.kill(-(fence.processGroupId ?? observed.processGroupId), signal);
    } catch {
      try {
        process.kill(fence.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          this.deps.logger.debug(
            `Unable to signal recovered process ${fence.pid}: ${ensureError(error).message}`
          );
        }
      }
    }
  }

  private async closeQuiescedRuntime(
    session: SessionInfo,
    epoch: number,
    options: { locallyTrackedTurn?: boolean } = {}
  ): Promise<void> {
    const oneShotRuntime = this.usesOneShotRuntime(session);
    const closureDeadline = Date.now() + QUIESCENCE_RUNTIME_TIMEOUT_MS;
    const controlTimeout = () =>
      Math.max(1, Math.min(QUIESCENCE_RUNTIME_COMMAND_TIMEOUT_MS, closureDeadline - Date.now()));
    const locallyTrackedTurn =
      options.locallyTrackedTurn ??
      (this.activeTurns.has(session.name) || this.activeTurnProcesses.has(session.name));
    this.stopRequests.add(session.name);
    const runtimeEnv = this.modelProviderRuntimeEnv(session.modelProvider, session.name);
    this.terminateActiveTurnProcess(session.name, "SIGTERM");
    await this.runControlCommand({
      args: this.buildVerbArgs(session.agent, session.directory, [
        "cancel",
        "--session",
        session.name
      ]),
      cwd: session.directory,
      timeoutMs: controlTimeout(),
      ...(runtimeEnv != null ? { env: runtimeEnv } : {})
    }).catch((error) => {
      this.deps.logger.debug(
        `Unable to cancel quiesced session ${session.name}: ${ensureError(error).message}`
      );
    });

    const drained = await this.waitForActiveTurnDrain(session.name);
    if (!drained) {
      throw new PuppenclawError(
        "QUIESCENCE_UNAVAILABLE",
        `Session ${session.name} did not drain for quiescence epoch ${epoch}.`,
        { name: session.name, quiescenceEpoch: epoch }
      );
    }

    if (oneShotRuntime) {
      if (session.state === "running" && !locallyTrackedTurn) {
        throw new PuppenclawError(
          "QUIESCENCE_UNAVAILABLE",
          `Direct one-shot runtime closure cannot be proved for session ${session.name} after manager restart.`,
          { name: session.name, quiescenceEpoch: epoch }
        );
      }
      await this.recordQuiescedSessionState(session.name, epoch);
      return;
    }

    await this.runControlCommand({
      args: this.buildVerbArgs(session.agent, session.directory, [
        "sessions",
        "close",
        session.name
      ]),
      cwd: session.directory,
      allowNoSession: true,
      timeoutMs: controlTimeout(),
      ...(runtimeEnv != null ? { env: runtimeEnv } : {})
    }).catch((error) => {
      this.deps.logger.debug(
        `Unable to close quiesced session ${session.name}: ${ensureError(error).message}`
      );
    });

    const deadline = Math.min(
      closureDeadline,
      Date.now() + QUIESCENCE_RUNTIME_COMMAND_TIMEOUT_MS
    );
    while (Date.now() < deadline) {
      const status = await this.getRuntimeStatus({
        name: session.name,
        agent: session.agent,
        directory: session.directory,
        timeoutMs: Math.max(1, Math.min(controlTimeout(), deadline - Date.now())),
        ...(session.modelProvider != null ? { modelProvider: session.modelProvider } : {})
      }).catch(() => ({ exists: true }));
      if (!status.exists) {
        await this.recordQuiescedSessionState(session.name, epoch);
        return;
      }
      await sleep(QUIESCENCE_POLL_MS);
    }
    throw new PuppenclawError(
      "QUIESCENCE_UNAVAILABLE",
      `ACP runtime closure could not be proved for session ${session.name}.`,
      { name: session.name, quiescenceEpoch: epoch }
    );
  }

  private async drainUnknownQuiescedTurn(
    name: string,
    epoch: number
  ): Promise<SessionInfo | null> {
    this.stopRequests.add(name);
    this.terminateActiveTurnProcess(name, "SIGTERM");
    const drained = await this.waitForActiveTurnDrain(name);
    if (!drained) {
      throw new PuppenclawError(
        "QUIESCENCE_UNAVAILABLE",
        `Initial start for session ${name} did not drain for quiescence epoch ${epoch}.`,
        { name, quiescenceEpoch: epoch }
      );
    }
    return this.deps.store.getSession(name);
  }

  private async recordQuiescedSessionState(name: string, epoch: number): Promise<void> {
    await this.deps.store.patchQuiescedSession(name, epoch, (current) => {
      const stoppedAt = nowIso();
      return {
        ...withoutRecoveryFence(withoutFocusLease(current)),
        state: "stopped",
        lastActivity: stoppedAt,
        lastStopReason: `quiesced at lifecycle epoch ${epoch}`,
        ...(current.activeTurn?.state === "running"
          ? {
              activeTurn: {
                ...current.activeTurn,
                state: "stopped" as const,
                updatedAt: stoppedAt,
                completedAt: stoppedAt
              }
            }
          : {})
      };
    });
  }

  private async waitForActiveTurnDrain(name: string): Promise<boolean> {
    const deadline = Date.now() + QUIESCENCE_DRAIN_TIMEOUT_MS;
    const escalationAt = Date.now() + Math.min(1_000, QUIESCENCE_DRAIN_TIMEOUT_MS / 2);
    while (Date.now() < deadline) {
      if (!this.activeTurns.has(name) && !this.activeTurnProcesses.has(name)) {
        return true;
      }
      const signal = Date.now() >= escalationAt ? "SIGKILL" : "SIGTERM";
      this.terminateActiveTurnProcess(name, signal);
      await sleep(QUIESCENCE_POLL_MS);
    }
    return !this.activeTurns.has(name) && !this.activeTurnProcesses.has(name);
  }

  private isTurnActive(session: SessionInfo): boolean {
    const tracked = this.activeTurnProcesses.get(session.name)?.child;
    return (
      this.activeTurns.has(session.name) ||
      (tracked != null && tracked.exitCode == null && tracked.signalCode == null)
    );
  }

  private withBrokerSocket(session: SessionInfo): SessionInfo {
    const brokerSocket = this.deps.advanced?.socket(session.name);
    return brokerSocket ? { ...session, brokerSocket } : session;
  }

  private decorateVisibleSession(session: SessionInfo): SessionInfo {
    session = this.withBrokerSocket(session);
    const activeQuiescence = this.deps.store.getQuiescence(session.name);
    if (activeQuiescence != null) {
      return {
        ...session,
        state: "stopped",
        lastStopReason: `quiesced at lifecycle epoch ${activeQuiescence.epoch}`
      };
    }
    if (this.stopRequests.has(session.name)) {
      return session;
    }
    if (!this.activeTurns.has(session.name)) {
      return session;
    }
    return {
      ...session,
      state: "running"
    };
  }

  private async reconcileVisibleSession(session: SessionInfo): Promise<{
    session: SessionInfo;
    turn: ActiveTurnRuntimeStatus;
  }> {
    const turn = await this.activeTurnRuntimeStatus(session);
    if (turn.classification === "orphaned") {
      const warning =
        "Persisted active turn has no matching live process; the turn is orphaned.";
      const orphanedAt =
        session.activeTurn?.state === "running"
          ? nowIso()
          : (session.activeTurn?.completedAt ?? session.activeTurn?.updatedAt ?? nowIso());
      return {
        session: {
          ...session,
          state: "failed",
          lastError: session.lastError ?? warning,
          warnings: dedupeWarnings([...session.warnings, warning]),
          ...(session.activeTurn != null
            ? {
                activeTurn: {
                  ...session.activeTurn,
                  state: "orphaned",
                  updatedAt: session.activeTurn.updatedAt,
                  completedAt: session.activeTurn.completedAt ?? orphanedAt
                }
              }
            : {})
        },
        turn
      };
    }
    if (turn.classification === "running" || turn.classification === "starting") {
      return {
        session: {
          ...session,
          state: "running"
        },
        turn
      };
    }
    return { session, turn };
  }

  private async activeTurnRuntimeStatus(
    session: SessionInfo
  ): Promise<ActiveTurnRuntimeStatus> {
    const activeTurn = session.activeTurn;
    const lockHeld = this.activeTurns.has(session.name);
    const tracked = this.activeTurnProcesses.get(session.name);
    const trackedChild = tracked != null;
    const pid = tracked?.child.pid ?? activeTurn?.pid ?? null;
    const observedIdentity = pid != null ? await readLinuxProcessIdentity(pid) : null;
    const pidReachable = pid != null ? pidMayExist(pid) : null;
    const expectedIdentity = activeTurn?.processStartIdentity;
    const identityMatches =
      expectedIdentity == null
        ? observedIdentity == null
          ? null
          : true
        : observedIdentity == null
          ? pidReachable === false
            ? false
            : null
          : observedIdentity.processStartIdentity === expectedIdentity;
    const trackedChildRunning =
      tracked != null && tracked.child.exitCode == null && tracked.child.signalCode == null;
    const processAlive =
      pid == null
        ? null
        : process.platform === "linux"
          ? observedIdentity != null
            ? identityMatches !== false
            : pidReachable === false
              ? false
              : null
          : trackedChild
            ? trackedChildRunning
            : null;
    let classification: ActiveTurnRuntimeStatus["classification"] = "inactive";
    let conflict: string | null = null;
    if (activeTurn?.state === "running") {
      if (lockHeld && this.deferredControllerCompletions.has(session.name)) {
        // The native controller process has finished, but this same live
        // attempt still owns its workers or is preparing the continuation.
        // This evidence never survives restart.
        classification = "running";
      } else if (processAlive === true || trackedChildRunning) {
        classification = "running";
      } else if (pid == null && lockHeld) {
        classification = "starting";
      } else if (pid == null) {
        classification = "running";
        conflict = "turn metadata says running but no process identity was recorded";
      } else if (processAlive == null) {
        classification = "running";
        conflict = "turn process liveness cannot be proved after restart";
      } else {
        classification = "orphaned";
        conflict =
          identityMatches === false
            ? "recorded PID is absent or belongs to a different process"
            : "turn metadata says running but process liveness is unverified";
      }
    } else if (activeTurn != null) {
      classification = activeTurn.state;
      if (lockHeld || trackedChildRunning) {
        conflict = `turn metadata says ${activeTurn.state} while an in-memory turn remains active`;
      }
    } else if (lockHeld || trackedChildRunning) {
      classification = pid == null ? "starting" : "running";
      conflict = "in-memory turn activity has no persisted lifecycle metadata";
    }
    const nowMs = Date.now();
    const startedMs = activeTurn?.startedAt != null ? Date.parse(activeTurn.startedAt) : Number.NaN;
    // Progress is persisted only on the checkpoint tick; the live turn in this
    // process has the current values.
    const liveOutput =
      activeTurn != null && this.activeTurnIds.get(session.name) === activeTurn.id
        ? this.activeTurnOutputs.get(session.name)
        : undefined;
    const lastOutputAt =
      liveOutput != null && liveOutput.totalChars > 0
        ? liveOutput.updatedAt
        : (activeTurn?.lastOutputAt ?? null);
    const outputMs = lastOutputAt != null ? Date.parse(lastOutputAt) : Number.NaN;
    return {
      classification,
      lockHeld,
      trackedChild,
      processAlive,
      identityMatches,
      pid,
      processGroupId:
        observedIdentity?.processGroupId ?? activeTurn?.processGroupId ?? null,
      startedAt: activeTurn?.startedAt ?? null,
      updatedAt: activeTurn?.updatedAt ?? null,
      lastOutputAt,
      outputChars: Math.max(activeTurn?.outputChars ?? 0, liveOutput?.totalChars ?? 0),
      ageMs: Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null,
      outputAgeMs: Number.isFinite(outputMs) ? Math.max(0, nowMs - outputMs) : null,
      conflict
    };
  }

  private async ensureConnectedCapacity(incomingSessionName: string): Promise<boolean> {
    return await this.withAdmissionLock(async () =>
      await this.ensureConnectedCapacityWithAdmissionLock(incomingSessionName)
    );
  }

  private async ensureConnectedCapacityWithAdmissionLock(
    incomingSessionName: string
  ): Promise<boolean> {
    while (true) {
      const incoming = this.deps.store.getSession(incomingSessionName);
      if (
        incoming != null &&
        isConnectedSession(incoming) &&
        !this.usesOneShotRuntime(incoming)
      ) {
        return false;
      }
      if (this.capacityReservations.has(incomingSessionName)) {
        this.addCapacityReservation(incomingSessionName);
        return true;
      }

      const maxSessions = this.deps.config.maxSessions || DEFAULT_MAX_SESSIONS;
      const connectedSessions = this.deps.store
        .listSessions()
        .filter(isConnectedSession)
        .filter((session) => !this.usesOneShotRuntime(session));
      const connectedNames = new Set(connectedSessions.map((session) => session.name));
      const pendingReservations = [...this.capacityReservations.keys()].filter(
        (name) => !connectedNames.has(name)
      );
      const admittedCount = connectedSessions.length + pendingReservations.length;
      if (admittedCount < maxSessions) {
        this.addCapacityReservation(incomingSessionName);
        return true;
      }

      const evictionCandidate = connectedSessions
        .filter((session) => session.name !== incomingSessionName)
        .filter((session) => !this.isTurnActive(session))
        .filter((session) => !isFocusLeaseActive(session))
        .sort((left, right) => Date.parse(left.lastActivity) - Date.parse(right.lastActivity))
        .at(0);

      if (evictionCandidate == null) {
        throw new PuppenclawError(
          "MAX_SESSIONS_REACHED",
          `Orchestrator has admitted ${admittedCount} persistent runtime sessions and none can be suspended.`
        );
      }

      const suspended = await this.withLifecycleLock(evictionCandidate.name, async () => {
        const current = this.deps.store.getSession(evictionCandidate.name);
        if (
          current == null ||
          !isConnectedSession(current) ||
          this.usesOneShotRuntime(current) ||
          this.isTurnActive(current) ||
          isFocusLeaseActive(current)
        ) {
          return false;
        }
        await this.suspendTrackedSession(
          current,
          `suspended by LRU eviction for ${incomingSessionName}`
        );
        return true;
      });
      if (!suspended) {
        continue;
      }
      this.addCapacityReservation(incomingSessionName);
      return true;
    }
  }

  private addCapacityReservation(name: string): void {
    this.capacityReservations.set(name, (this.capacityReservations.get(name) ?? 0) + 1);
  }

  private releaseCapacityReservation(name: string): void {
    const reservations = this.capacityReservations.get(name);
    if (reservations == null || reservations <= 1) {
      this.capacityReservations.delete(name);
      return;
    }
    this.capacityReservations.set(name, reservations - 1);
  }

  private async suspendTrackedSession(session: SessionInfo, reason: string): Promise<SessionInfo> {
    const runtimeEnv = this.modelProviderRuntimeEnv(session.modelProvider, session.name);
    await this.runControlCommand({
      args: this.buildVerbArgs(session.agent, session.directory, [
        "sessions",
        "close",
        session.name
      ]),
      cwd: session.directory,
      ...(runtimeEnv != null ? { env: runtimeEnv } : {})
    }).catch((error) => {
      this.deps.logger.warn(
        `Unable to close ACPX session ${session.name}: ${ensureError(error).message}`
      );
    });

    const nextSession: SessionInfo = {
      ...withoutFocusLease(session),
      state: "suspended",
      lastStopReason: reason
    };
    await this.deps.store.upsertSession(nextSession);
    this.deps.outputRouter.clear(session.name);
    return nextSession;
  }

  private buildRehydrationPrompt(session: SessionInfo, newPrompt: string): string {
    const transcriptText = session.transcript
      .map((entry) => `${entry.role.toUpperCase()}: ${entry.text}`)
      .join("\n\n")
      .trim();
    if (!transcriptText) {
      return newPrompt;
    }
    return [
      `This Orchestrator session ${session.name} was disconnected from the ACP runtime to free a worker slot.`,
      "Rehydrate the following transcript as prior context. Do not repeat it to the user unless needed.",
      "The full stored transcript is included. If it cannot fit in the active model context, explicitly report that context-size limit instead of silently ignoring earlier turns.",
      transcriptText,
      "Continue with this new user message:",
      newPrompt
    ].join("\n\n");
  }

  private skillSearchRoots(): string[] {
    return dedupeStrings([
      ...this.deps.config.skillRoots.map((root) => resolvePath(root)),
      PACKAGE_SKILLS_ROOT
    ]);
  }

  private async listAvailableSkills(): Promise<AvailableSkill[]> {
    const byName = new Map<string, AvailableSkill>();
    for (const root of this.skillSearchRoots()) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || !SKILL_NAME_PATTERN.test(entry.name)) {
          continue;
        }
        const sourcePath = join(root, entry.name, "SKILL.md");
        if (!byName.has(entry.name) && (await isFile(sourcePath))) {
          byName.set(entry.name, {
            name: entry.name,
            sourcePath
          });
        }
      }
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  private async resolveSkillPath(name: string): Promise<string | undefined> {
    for (const root of this.skillSearchRoots()) {
      const sourcePath = join(root, name, "SKILL.md");
      if (await isFile(sourcePath)) {
        return sourcePath;
      }
    }
    return undefined;
  }

  private async installSessionSkills(
    directory: string,
    skills: readonly string[]
  ): Promise<InstalledSkill[]> {
    const names = validateSkillNames(skills);
    if (names.length === 0) {
      return [];
    }

    const installed: InstalledSkill[] = [];
    for (const name of names) {
      const sourcePath = await this.resolveSkillPath(name);
      if (sourcePath == null) {
        throw new PuppenclawError(
          "SKILL_NOT_FOUND",
          `Skill "${name}" was not found in configured Orchestrator skill roots.`
        );
      }

      const targetDir = join(directory, ".claude", "skills", name);
      const targetPath = join(targetDir, "SKILL.md");
      await mkdir(targetDir, { recursive: true });
      await copyFile(sourcePath, targetPath);
      installed.push({
        name,
        sourcePath,
        targetPath
      });
    }
    return installed;
  }

  private createSession(params: {
    name: string;
    agent: AgentKind;
    directory: string;
    permissionMode: PermissionMode;
    effort?: EffortLevel;
    planningProfile?: PlanningProfile;
    model?: string;
    modelProviderId?: string;
    modelProvider?: ModelProviderConfig;
    skills?: string[];
    createdAt: string;
  }): SessionInfo {
    return {
      name: params.name,
      agent: params.agent,
      directory: params.directory,
      state: "idle",
      createdAt: params.createdAt,
      lastActivity: params.createdAt,
      permissionMode: params.permissionMode,
      ...(params.effort != null ? { effort: params.effort } : {}),
      ...(params.planningProfile != null ? { planningProfile: params.planningProfile } : {}),
      ...(params.model != null ? { model: params.model } : {}),
      ...(params.modelProviderId != null ? { modelProviderId: params.modelProviderId } : {}),
      ...(params.modelProvider != null ? { modelProvider: params.modelProvider } : {}),
      ...(params.skills != null && params.skills.length > 0 ? { skills: params.skills } : {}),
      warnings: [],
      transcript: [],
      handle: {
        runtimeSessionName: params.name,
        cwd: params.directory,
        agent: params.agent,
        mode: "persistent"
      }
    };
  }

  private requireSession(name: string): SessionInfo {
    const session = this.deps.store.getSession(name);
    if (session == null) {
      throw new PuppenclawError("NO_SESSION", `Unknown session ${name}.`);
    }
    return session;
  }

  private effectivePermissionMode(session: SessionInfo): PermissionMode {
    return session.permissionMode;
  }

  private resolveSessionReasoning(session: SessionInfo): {
    session: SessionInfo;
    warning?: string;
  } {
    const profile = reasoningProfileFor(session);
    const requested = session.effort ?? (profile === "qwen-3.8" ? "medium" : undefined);
    if (requested == null) {
      return {
        session: {
          ...session,
          reasoningProfile: profile
        }
      };
    }
    const resolution = resolveReasoningMode(session, requested);
    if (resolution == null) {
      throw new PuppenclawError(
        "UNSUPPORTED_REASONING_MODE",
        `Reasoning mode "${requested}" is not supported by the ${profile} profile.`,
        {
          profile,
          requested,
          accepted: acceptedReasoningModes(profile)
        }
      );
    }
    return {
      session: {
        ...session,
        effort: requested,
        reasoningProfile: resolution.profile,
        effectiveEffort: resolution.effective,
        runtimeEffort: resolution.runtimeValue
      },
      ...(resolution.warning != null ? { warning: resolution.warning } : {})
    };
  }

  private modelProviderRuntimeEnv(
    modelProvider: ModelProviderConfig | undefined, sessionName?: string
  ): NodeJS.ProcessEnv | undefined {
    if (modelProvider == null) {
      return undefined;
    }
    return {
      ...(sessionName ? this.deps.advanced?.environment(sessionName) : {}),
      PUPPENCLAW_MODEL_PROVIDER_ID: modelProvider.id,
      PUPPENCLAW_MODEL_PROVIDER_MODEL: modelProvider.model,
      ...(modelProvider.label != null
        ? { PUPPENCLAW_MODEL_PROVIDER_LABEL: modelProvider.label }
        : {}),
      ...(modelProvider.kind != null ? { PUPPENCLAW_MODEL_PROVIDER_KIND: modelProvider.kind } : {}),
      ...(modelProvider.baseUrl != null
        ? { PUPPENCLAW_MODEL_PROVIDER_BASE_URL: modelProvider.baseUrl }
        : {}),
      ...(modelProvider.authTokenEnv != null
        ? { PUPPENCLAW_MODEL_PROVIDER_AUTH_TOKEN_ENV: modelProvider.authTokenEnv }
        : {}),
      ...(modelProvider.wireApi != null
        ? { PUPPENCLAW_MODEL_PROVIDER_WIRE_API: modelProvider.wireApi }
        : {}),
      ...(modelProvider.reasoningProfile != null
        ? { PUPPENCLAW_MODEL_PROVIDER_REASONING_PROFILE: modelProvider.reasoningProfile }
        : {}),
      ...(modelProvider.subagents != null
        ? {
            PUPPENCLAW_MODEL_PROVIDER_SUBAGENT_MODEL: modelProvider.subagents.model,
            PUPPENCLAW_MODEL_PROVIDER_SUBAGENT_EFFORT: modelProvider.subagents.effort,
            PUPPENCLAW_MODEL_PROVIDER_SUBAGENT_MAX_THREADS: String(
              modelProvider.subagents.maxConcurrentThreads
            )
          }
        : {})
    };
  }

  private usesOneShotRuntime(session: {
    agent: AgentKind;
    modelProvider?: ModelProviderConfig;
  }): boolean {
    return session.agent === "codex" && session.modelProvider != null;
  }

  private async prepareModelProviderRefresh(
    session: SessionInfo,
    params: Pick<SendParams, "modelProviderId" | "modelProvider">
  ): Promise<{ session: SessionInfo; refreshed: boolean }> {
    const requestedId = params.modelProviderId;
    const requestedProvider = params.modelProvider;
    if (requestedId == null && requestedProvider == null) {
      return { session, refreshed: false };
    }
    if (requestedId == null || requestedProvider == null) {
      throw new PuppenclawError(
        "MODEL_PROVIDER_REFRESH_INVALID",
        "A daemon model-provider refresh requires both modelProviderId and modelProvider."
      );
    }
    if (requestedId !== requestedProvider.id) {
      throw new PuppenclawError(
        "MODEL_PROVIDER_REFRESH_INVALID",
        "modelProviderId must exactly match modelProvider.id."
      );
    }
    const supportsCodexRefresh =
      session.agent === "codex" &&
      ["codex-openai", "codex-openai-compatible"].includes(
        requestedProvider.kind ?? ""
      );
    const supportsClaudeRefresh =
      session.agent === "claude" && requestedProvider.kind === "claude-code";
    if (!supportsCodexRefresh && !supportsClaudeRefresh) {
      throw new PuppenclawError(
        "MODEL_PROVIDER_REFRESH_UNSUPPORTED",
        "Model-provider refresh requires a matching Codex one-shot or Claude Code provider."
      );
    }

    const storedIds = [session.modelProviderId, session.modelProvider?.id].filter(
      (value): value is string => value != null
    );
    if (storedIds.some((storedId) => storedId !== requestedId)) {
      throw new PuppenclawError(
        "MODEL_PROVIDER_REFRESH_CONFLICT",
        `Session ${session.name} is already bound to a different model provider.`
      );
    }

    if (supportsCodexRefresh && session.modelProvider == null) {
      await this.closeLegacyRuntimeForProviderRefresh(session);
    }

    if (supportsClaudeRefresh && requiresFreshClaudeTranscript(session.modelProvider?.model ?? session.model, requestedProvider.model)) {
      throw new PuppenclawError(
        "MODEL_TRANSCRIPT_INCOMPATIBLE",
        "This model change requires a fresh runner session rehydrated from visible conversation only; native Fable thinking cannot be resumed by another generation."
      );
    }

    return {
      session: {
        ...session,
        model: requestedProvider.model,
        modelProviderId: requestedId,
        modelProvider: requestedProvider
      },
      refreshed: true
    };
  }

  private async closeLegacyRuntimeForProviderRefresh(session: SessionInfo): Promise<void> {
    const status = await this.getRuntimeStatus({
      name: session.name,
      agent: session.agent,
      directory: session.directory,
      timeoutMs: QUIESCENCE_CONTROL_TIMEOUT_MS
    });
    if (!status.exists || status.status === "dead") {
      return;
    }

    await this.runControlCommand({
      args: this.buildVerbArgs(session.agent, session.directory, [
        "sessions",
        "close",
        session.name
      ]),
      cwd: session.directory,
      allowNoSession: true,
      timeoutMs: QUIESCENCE_CONTROL_TIMEOUT_MS
    });
    const closedStatus = await this.getRuntimeStatus({
      name: session.name,
      agent: session.agent,
      directory: session.directory,
      timeoutMs: QUIESCENCE_CONTROL_TIMEOUT_MS
    });
    if (closedStatus.exists && closedStatus.status !== "dead") {
      throw new PuppenclawError(
        "MODEL_PROVIDER_REFRESH_UNSAFE",
        `Persistent ACP runtime ${session.name} remained active; provider refresh was not applied.`
      );
    }
  }

  private buildOneShotContinuationPrompt(session: SessionInfo, promptText: string): string {
    if (session.transcript.length === 0) {
      return promptText;
    }
    const transcript = session.transcript
      .map((entry) => `${entry.role.toUpperCase()}: ${entry.text}`)
      .join("\n\n");
    return [
      "Continue the existing Puppenclaw session using the transcript below as prior context.",
      "The full stored transcript is included. If it cannot fit in the active model context, explicitly report that context-size limit instead of silently ignoring earlier turns.",
      `Session name: ${session.name}`,
      "",
      "Prior transcript:",
      transcript,
      "",
      "New request:",
      promptText
    ].join("\n");
  }

  private resolveCapabilityWarnings(params: {
    agent: AgentKind;
    model?: string;
    effort?: EffortLevel;
    planningProfile?: PlanningProfile;
  }): string[] {
    const warnings: string[] = [];
    if (params.model != null) {
      warnings.push(
        `Requested model override "${params.model}" is forwarded to the selected agent runtime.`
      );
    }
    if (params.planningProfile != null) {
      warnings.push(
        `Planning profile "${params.planningProfile}" is enforced through the synthesized prompt, not a guaranteed ACP runtime mode.`
      );
    }
    if (Object.keys(this.deps.config.mcpServers).length > 0) {
      warnings.push(
        "Configured MCP servers are recorded by Puppenclaw, but ACP adapter-side MCP injection must be handled by the target agent command."
      );
    }
    if (this.deps.config.agentCommands[params.agent]?.trim()) {
      warnings.push(`Using configured raw agent command for ${params.agent}.`);
    }
    return warnings;
  }

  private buildPlanningPromptPrefix(params: {
    agent: AgentKind;
    planningProfile?: PlanningProfile;
  }): string | undefined {
    const profile = params.planningProfile;
    if (profile == null) {
      return undefined;
    }
    const lines = [
      `You are running through Puppenclaw on the ${params.agent} backend.`,
      "Plan before implementation, keep ownership explicit, and only return to the human on a real decision boundary."
    ];
    if (profile === "deep") {
      lines.push(
        "Use a deep planning pass first: clarify scope, architecture, major file or system changes, validation strategy, and open decision boundaries before coding."
      );
    } else if (profile === "quick") {
      lines.push(
        "Use a short planning pass first: summarize the implementation approach, main changes, and validation steps before coding."
      );
    } else {
      lines.push(
        "Planning profile is off: keep planning concise, but do not skip clarification when key requirements are missing."
      );
    }
    return lines.join("\n");
  }

  private buildVerbArgs(
    agent: AgentKind,
    cwd: string,
    command: string[],
    prompt = false,
    permissionMode?: PermissionMode
  ): string[] {
    const args = ["--format", "json"];
    if (!prompt) {
      args.push("--json-strict");
    }
    args.push("--cwd", cwd);
    if (prompt) {
      args.push(...buildPermissionArgs(permissionMode ?? this.deps.config.permissionMode));
      args.push("--non-interactive-permissions", "deny");
    }
    const rawAgentCommand = this.deps.config.agentCommands[agent];
    if (rawAgentCommand != null && rawAgentCommand.trim().length > 0) {
      args.push("--agent", rawAgentCommand.trim());
    } else {
      args.push(agent);
    }
    args.push(...command);
    return args;
  }

  private async ensureRuntimeSession(params: {
    name: string;
    agent: AgentKind;
    directory: string;
    model?: string;
    effort?: EffortLevel;
    ultracode?: boolean;
    modelProvider?: ModelProviderConfig;
    /** Re-send config options even when they match the last applied values. */
    forceApply?: boolean;
    /**
     * Downgrade a rejected model set to a warning instead of failing. Only for
     * non-turn reconnect paths (resume): nothing is remembered as applied, so
     * the next turn re-attempts the set and fails loudly with
     * MODEL_UNAVAILABLE before anything can run or be ledgered.
     */
    tolerateModelRejection?: boolean;
  }): Promise<void> {
    const runtimeEnv = this.modelProviderRuntimeEnv(params.modelProvider, params.name);
    const status = await this.getRuntimeStatus(params);
    const createdRuntime = !status.exists || status.status === "dead";
    if (createdRuntime) {
      const args = this.buildVerbArgs(params.agent, params.directory, [
        "sessions",
        "new",
        "--name",
        params.name
      ]);
      await this.runControlCommand({
        args,
        cwd: params.directory,
        ...(runtimeEnv != null ? { env: runtimeEnv } : {})
      });
      this.appliedRuntimeConfigBySession.delete(params.name);
    }
    const appliedRuntimeConfig =
      createdRuntime || params.forceApply === true
        ? undefined
        : this.appliedRuntimeConfigBySession.get(params.name);
    if (params.model != null && params.model !== appliedRuntimeConfig?.model) {
      const requestedModel = params.model;
      let modelApplied = false;
      await this.runControlCommand({
        args: this.buildVerbArgs(params.agent, params.directory, [
          "set",
          "model",
          requestedModel,
          "--session",
          params.name
        ]),
        cwd: params.directory,
        ...(runtimeEnv != null ? { env: runtimeEnv } : {})
      })
        .then(() => {
          modelApplied = true;
        })
        .catch(async (error) => {
          const cause = ensureError(error).message;
          // The literal "default" selector keeps the historical tolerant
          // behavior: running the adapter default IS the requested outcome,
          // so a rejected set cannot silently bill a different model.
          if (requestedModel === "default" || params.tolerateModelRejection === true) {
            this.deps.logger.warn(
              `Unable to set ACPX model for session ${params.name}: ${cause}`
            );
            return;
          }
          if (createdRuntime) {
            await this.runControlCommand({
              args: this.buildVerbArgs(params.agent, params.directory, [
                "sessions",
                "close",
                params.name
              ]),
              cwd: params.directory,
              ...(runtimeEnv != null ? { env: runtimeEnv } : {})
            }).catch(() => {
              // Best-effort cleanup of a runtime that never became usable.
            });
          }
          // Deployment safety: a session that pinned a model must never
          // silently run — and get ledgered as — a different generation
          // because a stale adapter rejected the selector. Fail the turn.
          throw new PuppenclawError(
            "MODEL_UNAVAILABLE",
            `ACP runtime rejected model "${requestedModel}" for session ${params.name}: ${cause}`,
            {
              agent: params.agent,
              requested: requestedModel
            }
          );
        });
      this.rememberAppliedRuntimeConfig(params.name, {
        model: modelApplied ? requestedModel : null
      });
    }
    // A successful versioned config request is the capability handshake. Never
    // send a workflow prompt to an adapter that only understands effort levels.
    if (params.agent === "claude" && (params.ultracode === true || params.model?.startsWith("claude-fable-"))) {
      try {
        await this.runControlCommand({
          args: this.buildVerbArgs(params.agent, params.directory, [
            "set", "ocsl_workflow_v1", params.ultracode ? "ultracode" : "off", "--session", params.name
          ]),
          cwd: params.directory,
          ...(runtimeEnv != null ? { env: runtimeEnv } : {})
        });
      } catch (error) {
        if (createdRuntime) {
          await this.runControlCommand({
            args: this.buildVerbArgs(params.agent, params.directory, ["sessions", "close", params.name]),
            cwd: params.directory,
            ...(runtimeEnv != null ? { env: runtimeEnv } : {})
          }).catch(() => undefined);
        }
        throw new PuppenclawError("UNAVAILABLE_REASONING_MODE", "The selected Claude runtime does not support the required native workflow protocol.", { cause: ensureError(error).message });
      }
    }
    if (params.effort != null && params.effort !== appliedRuntimeConfig?.effort) {
      const effortConfigId = params.agent === "claude" ? "effort" : "reasoning_effort";
      await this.runControlCommand({
        args: this.buildVerbArgs(params.agent, params.directory, [
          "set",
          effortConfigId,
          params.effort,
          "--session",
          params.name
        ]),
        cwd: params.directory,
        ...(runtimeEnv != null ? { env: runtimeEnv } : {})
      }).catch(async (error) => {
        const cause = ensureError(error).message;
        if (createdRuntime) {
          await this.runControlCommand({
            args: this.buildVerbArgs(params.agent, params.directory, [
              "sessions",
              "close",
              params.name
            ]),
            cwd: params.directory,
            ...(runtimeEnv != null ? { env: runtimeEnv } : {})
          }).catch(() => {
            // Best-effort cleanup of a runtime that never became usable.
          });
        }
        if (isReasoningOptionRejection(error)) {
          throw new PuppenclawError(
            "UNSUPPORTED_REASONING_MODE",
            `ACP runtime rejected reasoning mode "${params.effort}" for session ${params.name}: ${cause}`,
            {
              agent: params.agent,
              requested: params.effort
            }
          );
        }
        throw error;
      });
      this.rememberAppliedRuntimeConfig(params.name, { effort: params.effort });
    }
    await this.waitForRuntimeSessionReady(params);
  }

  private rememberAppliedRuntimeConfig(
    name: string,
    patch: { model?: string | null; effort?: EffortLevel | null }
  ): void {
    const applied = this.appliedRuntimeConfigBySession.get(name) ?? {};
    const model = patch.model === undefined ? applied.model : (patch.model ?? undefined);
    const effort = patch.effort === undefined ? applied.effort : (patch.effort ?? undefined);
    this.appliedRuntimeConfigBySession.set(name, {
      ...(model != null ? { model } : {}),
      ...(effort != null ? { effort } : {})
    });
  }

  private async waitForRuntimeSessionReady(params: {
    name: string;
    agent: AgentKind;
    directory: string;
    modelProvider?: ModelProviderConfig;
  }): Promise<void> {
    const deadline = Date.now() + 20_000;
    let lastStatus = "unknown";
    while (Date.now() < deadline) {
      try {
        const status = await this.getRuntimeStatus(params);
        lastStatus = describeRuntimeStatus(status);
        if (isRuntimeStatusReady(status)) {
          return;
        }
      } catch (error) {
        lastStatus = ensureError(error).message;
      }
      await sleep(500);
    }
    this.deps.logger.warn(
      `Timed out waiting for ACPX session ${params.name} to become ready: ${lastStatus}`
    );
  }

  private async getRuntimeStatus(params: {
    name: string;
    agent: AgentKind;
    directory: string;
    modelProvider?: ModelProviderConfig;
    timeoutMs?: number;
  }): Promise<RuntimeStatus> {
    const runtimeEnv = this.modelProviderRuntimeEnv(params.modelProvider, params.name);
    const result = await this.runControlCommand({
      args: this.buildVerbArgs(params.agent, params.directory, [
        "status",
        "--session",
        params.name
      ]),
      cwd: params.directory,
      ...(runtimeEnv != null ? { env: runtimeEnv } : {}),
      allowNoSession: true,
      ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {})
    });
    const events = parseJsonLines(result.stdout);
    const error = events.map((event) => toErrorRecord(event)).find(Boolean) ?? null;
    if (error?.code === "NO_SESSION") {
      return { exists: false };
    }
    const detail = events.find((event) => toErrorRecord(event) == null) ?? null;
    if (isNoSessionStatus(detail)) {
      return { exists: false };
    }
    return {
      exists: detail != null,
      ...(detail != null
        ? { status: asOptionalString(detail.status) ?? "unknown", raw: detail }
        : {})
    };
  }

  private async getRuntimeSessionRecord(session: SessionInfo): Promise<JsonRecord | null> {
    const runtimeEnv = this.modelProviderRuntimeEnv(session.modelProvider, session.name);
    const result = await this.runControlCommand({
      args: this.buildVerbArgs(session.agent, session.directory, [
        "sessions",
        "show",
        session.name
      ]),
      cwd: session.directory,
      ...(runtimeEnv != null ? { env: runtimeEnv } : {})
    });
    return parseJsonLines(result.stdout).find((event) => toErrorRecord(event) == null) ?? null;
  }

  private async waitForDelayedAssistantOutput(params: {
    session: SessionInfo;
    cursor: RuntimeTurnCursor;
    promptText: string;
  }): Promise<string | undefined> {
    const deadline = Date.now() + RECONNECT_HISTORY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.stopRequests.has(params.session.name)) return undefined;
      try {
        const record = await this.getRuntimeSessionRecord(params.session);
        if (this.stopRequests.has(params.session.name)) return undefined;
        const output = extractCurrentTurnAgentText(record, params.cursor, params.promptText);
        if (output != null) {
          return output;
        }
        if (record?.acpxRecordId !== params.cursor.recordId) return undefined;
      } catch (error) {
        if (this.stopRequests.has(params.session.name)) return undefined;
        this.deps.logger.debug(
          `Waiting for delayed ACPX output for ${params.session.name}: ${ensureError(error).message}`
        );
      }
      await sleep(RECONNECT_HISTORY_POLL_MS);
    }
    return undefined;
  }

  private async prepareNativeInteractionMode(params: {
    session: SessionInfo;
    interactionMode?: InteractionMode;
  }): Promise<NativeModePreparation> {
    if (
      params.interactionMode == null ||
      params.session.agent !== "claude" ||
      this.usesOneShotRuntime(params.session)
    ) {
      return {};
    }

    const sessionRecord = await this.getRuntimeSessionRecord(params.session).catch(() => null);
    const modeStateFromRecord = extractRuntimeModeState(sessionRecord);
    const modeState =
      modeStateFromRecord ??
      extractRuntimeModeState(
        (
          await this.getRuntimeStatus({
            name: params.session.name,
            agent: params.session.agent,
            directory: params.session.directory,
            ...(params.session.modelProvider != null
              ? { modelProvider: params.session.modelProvider }
              : {})
          })
        ).raw
      );
    if (modeState == null) {
      return {
        warning: `ACP runtime did not advertise session modes; ${params.interactionMode} intent is enforced through the prompt and permission boundary.`
      };
    }

    const targetMode =
      params.interactionMode === "plan"
        ? modeState.availableModes == null || modeState.availableModes.includes("plan")
          ? "plan"
          : undefined
        : modeState.currentMode === "plan"
          ? (modeState.availableModes?.find((mode) => mode === "default") ??
            modeState.availableModes?.find((mode) => mode === "code") ??
            modeState.availableModes?.find((mode) => mode !== "plan") ??
            (modeState.availableModes == null ? "default" : undefined))
          : modeState.currentMode;
    if (targetMode == null) {
      return {
        activeMode: modeState.currentMode,
        warning: `ACP runtime does not advertise a mode compatible with ${params.interactionMode}; intent is enforced through the prompt and permission boundary.`
      };
    }
    if (targetMode === modeState.currentMode) {
      return { activeMode: modeState.currentMode };
    }

    const runtimeEnv = this.modelProviderRuntimeEnv(params.session.modelProvider, params.session.name);
    try {
      await this.runControlCommand({
        args: this.buildVerbArgs(params.session.agent, params.session.directory, [
          "set-mode",
          targetMode,
          "--session",
          params.session.name
        ]),
        cwd: params.session.directory,
        ...(runtimeEnv != null ? { env: runtimeEnv } : {})
      });
    } catch (error) {
      const advertised = modeState.availableModes?.includes(targetMode) === true;
      if (!advertised && params.interactionMode === "plan") {
        return {
          activeMode: modeState.currentMode,
          warning: `ACP runtime did not advertise plan mode and rejected a capability probe; plan intent is enforced through the prompt and permission boundary.`
        };
      }
      throw new PuppenclawError(
        "ACP_MODE_SWITCH_FAILED",
        `ACP runtime advertised mode "${targetMode}" but rejected the transition for session ${params.session.name}: ${ensureError(error).message}`,
        {
          name: params.session.name,
          requestedMode: targetMode,
          previousMode: modeState.currentMode
        }
      );
    }
    return {
      activeMode: targetMode,
      restoreMode: modeState.currentMode
    };
  }

  private async restoreNativeInteractionMode(
    session: SessionInfo,
    preparation: NativeModePreparation
  ): Promise<void> {
    if (preparation.restoreMode == null || preparation.restoreMode === preparation.activeMode) {
      return;
    }
    const runtimeEnv = this.modelProviderRuntimeEnv(session.modelProvider, session.name);
    await this.runControlCommand({
      args: this.buildVerbArgs(session.agent, session.directory, [
        "set-mode",
        preparation.restoreMode,
        "--session",
        session.name
      ]),
      cwd: session.directory,
      ...(runtimeEnv != null ? { env: runtimeEnv } : {})
    });
  }

  private async runTurn(params: {
    session: SessionInfo;
    promptText: string;
    permissionMode: PermissionMode;
    interactionMode?: InteractionMode;
    retryAfterReconnect?: boolean;
  }): Promise<TurnResult> {
    const advanced = this.deps.advanced;
    const name = params.session.name;
    if (!advanced?.controller(name)) return this.runNativeTurn(params);
    this.deferredControllerCompletions.add(name);
    try {
      let turn = await this.runNativeTurn(params);
      while (turn.state === "idle" && turn.signals?.plan?.source !== "claude-tool" && advanced.pendingWorkers(name).length > 0) {
        this.assertTurnWasNotStopped(name);
        await this.deps.outputRouter.onActivity(name, {
          type: "status", status: "running", title: "Waiting for workers",
          text: "The controller is waiting for its submitted workers before integrating their results."
        });
        const jobs = await advanced.joinWorkers(name);
        this.assertTurnWasNotStopped(name);
        this.deps.store.assertSessionMutable(name);
        if (!advanced.controller(name)) throw new PuppenclawError("ORCHESTRATION_TURN_CLOSED", "The parent worker attempt closed before result integration.");
        if (jobs.length === 0) break;
        const notification = [
          "The worker jobs submitted by this same approved turn have now settled. Continue the existing task by inspecting their stored results and integrating the findings before replying to the user.",
          "This is a lifecycle notification, not a new user request or approval. Preserve the current permissions and scope. Do not resubmit completed work or automatically retry failed, cancelled, interrupted or paused jobs. If a worker requires access or approval, explain that boundary and wait for the user.",
          "Worker identifiers and states (quoted data):",
          JSON.stringify(jobs.map((job) => ({ jobId: job.jobId, configId: job.config.id, kind: job.kind, state: job.state })))
        ].join("\n\n");
        const continuationSession = {
          ...params.session,
          transcript: mergeTranscript(params.session.transcript, [...makeUserTranscript(params.promptText), ...turn.transcript])
        };
        const next = await this.runNativeTurn({
          ...params, session: continuationSession,
          promptText: this.usesOneShotRuntime(continuationSession)
            ? this.buildOneShotContinuationPrompt(continuationSession, notification) : notification
        });
        turn = {
          ...next,
          transcript: [...turn.transcript, ...next.transcript],
          warnings: dedupeWarnings([...turn.warnings, ...next.warnings]),
          durationMs: (turn.durationMs ?? 0) + (next.durationMs ?? 0)
        };
      }
      this.assertTurnWasNotStopped(name);
      this.deps.store.assertSessionMutable(name);
      if (!advanced.controller(name)) throw new PuppenclawError("ORCHESTRATION_TURN_CLOSED", "The parent worker attempt closed before completion.");
      if (advanced.pausedWorkers(name).length > 0 && turn.state === "idle") {
        turn = { ...turn, state: "waiting_input", question: "A worker is paused and requires your approval or restored provider access before it can resume." };
      }
      if (turn.state === "idle" || turn.state === "waiting_input") {
        await this.publishSuccessfulTurn(name, turn.output, turn.question);
      }
      return turn;
    } finally {
      this.deferredControllerCompletions.delete(name);
      this.completeActiveTurnOutput(name);
    }
  }

  private async runNativeTurn(params: {
    session: SessionInfo;
    promptText: string;
    permissionMode: PermissionMode;
    interactionMode?: InteractionMode;
    retryAfterReconnect?: boolean;
  }): Promise<TurnResult> {
    const nativeMode = await this.prepareNativeInteractionMode(params);
    let turn: TurnResult;
    try {
      turn = await this.runRuntimeTurn(params);
    } catch (error) {
      await this.restoreNativeInteractionMode(params.session, nativeMode).catch((restoreError) => {
        this.deps.logger.warn(
          `Unable to restore ACP mode for ${params.session.name}: ${redactSensitiveText(ensureError(restoreError).message)}`
        );
      });
      throw error;
    }

    const restoreWarning = await this.restoreNativeInteractionMode(params.session, nativeMode).then(
      () => undefined,
      (error) => {
        const message = `Unable to restore ACP mode for ${params.session.name}: ${redactSensitiveText(ensureError(error).message)}`;
        this.deps.logger.warn(message);
        return message;
      }
    );
    const signals = mergeTurnSignals(
      nativeMode.activeMode != null ? { nativeMode: nativeMode.activeMode } : undefined,
      turn.signals
    );
    return {
      ...turn,
      warnings: dedupeWarnings([
        ...turn.warnings,
        ...(nativeMode.warning != null ? [nativeMode.warning] : []),
        ...(restoreWarning != null ? [restoreWarning] : [])
      ]),
      ...(signals != null ? { signals } : {})
    };
  }

  private async runRuntimeTurn(params: {
    session: SessionInfo;
    promptText: string;
    permissionMode: PermissionMode;
    interactionMode?: InteractionMode;
    retryAfterReconnect?: boolean;
  }): Promise<TurnResult> {
    this.deps.store.assertSessionMutable(params.session.name);
    if (this.usesOneShotRuntime(params.session)) {
      return await this.runCodexOneShotTurn(params);
    }

    const cursor = runtimeTurnCursor(
      await this.getRuntimeSessionRecord(params.session).catch(() => null)
    );
    const promptStartedAtMs = Date.now();
    await this.startActiveTurnOutput(params.session);
    this.assertTurnWasNotStopped(params.session.name);
    const args = this.buildVerbArgs(
      params.session.agent,
      params.session.directory,
      ["prompt", "--session", params.session.name, "--file", "-"],
      true,
      params.permissionMode
    );
    const spawnCommand = resolveSpawnCommand(this.deps.config.acpxCommand ?? "acpx", args);
    const runtimeEnv = this.modelProviderRuntimeEnv(params.session.modelProvider, params.session.name);
    const env = runtimeEnv != null ? { ...process.env, ...runtimeEnv } : process.env;
    const child = spawnCommand.shell
      ? spawn(spawnCommand.command, {
          cwd: params.session.directory,
          stdio: ["pipe", "pipe", "pipe"],
          shell: true,
          detached: process.platform !== "win32",
          env
        })
      : spawn(spawnCommand.command, spawnCommand.args, {
          cwd: params.session.directory,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          env
        });
    this.deps.runners?.track(child, { kind: "turn", sessionName: params.session.name });
    const exit = childExit(child);
    void exit.catch(() => undefined);
    await this.registerActiveTurnProcess(params.session.name, child);

    // If the child exits or closes stdin before the prompt is fully written
    // (bad auth, oversized prompt, immediate crash), the write surfaces an
    // EPIPE as an 'error' event on stdin. Without a listener that is an
    // UNCAUGHT exception that would crash the whole process, so swallow it
    // here; the turn outcome is decided by the exit code / error events.
    child.stdin.on("error", (error: Error) => {
      this.deps.logger.debug(
        `Orchestrator prompt stdin error for ${params.session.name}: ${error.message}`
      );
    });
    child.stdin.setDefaultEncoding("utf8");
    child.stdin.write(params.promptText);
    child.stdin.end();

    const events: PromptEvent[] = [];
    const planPermissions = new AcpPlanPermissionTracker();
    const dispatchTasks: Array<Promise<void>> = [];
    const outputChunks: string[] = [];
    let latestTokenUsage: TokenUsage | undefined;
    let latestNormalizedUsage: NormalizedUsage | undefined;
    let pendingStdout = "";
    let stderr = "";
    const recordNormalizedUsage = (usage: NormalizedUsage): void => {
      latestNormalizedUsage = usage;
      latestTokenUsage = {
        ...latestTokenUsage,
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite
      };
    };
    const consumeLine = (line: string): void => {
      planPermissions.observeLine(line);
      if (this.deps.statistics) {
        try { this.deps.statistics.observeEvent(params.session.name, JSON.parse(line), "acp"); } catch { /* Malformed protocol lines are not metrics. */ }
      }
      const event = parsePromptEventLine(line);
      if (event != null) {
        events.push(event);
        if (event.type === "text_delta" && event.stream === "output") {
          outputChunks.push(event.text);
          this.appendActiveTurnOutput(params.session.name, event.text);
          dispatchTasks.push(this.deps.outputRouter.onChunk(params.session.name, event.text));
        }
        if (event.type === "tool_call") {
          dispatchTasks.push(
            this.deps.outputRouter.onActivity(params.session.name, {
              type: "tool_call",
              title: event.title,
              ...(event.status != null ? { status: event.status } : {}),
              ...(event.toolCallId != null ? { toolCallId: event.toolCallId } : {})
            })
          );
        }
        if (event.type === "plan") {
          dispatchTasks.push(
            this.deps.outputRouter.onActivity(params.session.name, {
              type: "status",
              text: "Agent plan updated."
            })
          );
        }
        if (event.type === "mode") {
          dispatchTasks.push(
            this.deps.outputRouter.onActivity(params.session.name, {
              type: "status",
              text: `Agent mode changed to ${event.mode}.`
            })
          );
        }
        if (event.type === "status") {
          if (event.used != null || event.size != null) {
            latestTokenUsage = {
              ...latestTokenUsage,
              ...(event.used != null ? { used: event.used } : {}),
              ...(event.size != null ? { size: event.size } : {})
            };
          }
          if (event.usage != null && hasNonzeroUsage(event.usage)) {
            recordNormalizedUsage(event.usage);
          }
        }
        if (event.type === "done" && event.usage != null && hasNonzeroUsage(event.usage)) {
          recordNormalizedUsage(event.usage);
        }
        return;
      }

      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) {
          return;
        }
        const rawText =
          asOptionalTextDelta(parsed.text) ??
          (isRecord(parsed.content) ? asOptionalTextDelta(parsed.content.text) : undefined);
        if (rawText != null) {
          outputChunks.push(rawText);
          this.appendActiveTurnOutput(params.session.name, rawText);
          dispatchTasks.push(this.deps.outputRouter.onChunk(params.session.name, rawText));
        }
        const used = asOptionalFiniteNumber(parsed.used);
        const size = asOptionalFiniteNumber(parsed.size);
        if (used != null || size != null) {
          latestTokenUsage = {
            ...latestTokenUsage,
            ...(used != null ? { used } : {}),
            ...(size != null ? { size } : {})
          };
        }
        const usage = normalizeUsage(parsed);
        if (hasNonzeroUsage(usage)) {
          recordNormalizedUsage(usage);
        }
      } catch {
        // ignore malformed fallback lines
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pendingStdout += chunk;
      while (true) {
        const newlineIndex = pendingStdout.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }
        const line = pendingStdout.slice(0, newlineIndex).trim();
        pendingStdout = pendingStdout.slice(newlineIndex + 1);
        if (line) {
          consumeLine(line);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const { code: exitCode, signal: exitSignal } = await exit.catch((error) => {
      this.completeActiveTurnOutput(params.session.name);
      throw normalizeProviderError(
        params.session,
        new PuppenclawError("ACP_TURN_FAILED", ensureError(error).message)
      );
    });

    const trailingLine = pendingStdout.trim();
    if (trailingLine) {
      consumeLine(trailingLine);
    }

    await Promise.all(dispatchTasks);

    const stoppedTurn = (): TurnResult | undefined => {
      if (!this.stopRequests.has(params.session.name) &&
          this.deps.store.getSession(params.session.name)?.state !== "stopped") return undefined;
      this.completeActiveTurnOutput(params.session.name);
      return {
        output: "Turn stopped by user.",
        outputRole: "status",
        warnings: [],
        transcript: [{ role: "status", text: "Turn stopped by user.", createdAt: nowIso() }],
        state: "stopped",
        ...(latestTokenUsage != null ? { tokenUsage: latestTokenUsage } : {}),
        ...(latestNormalizedUsage != null ? { usage: latestNormalizedUsage } : {})
      };
    };
    let stopped = stoppedTurn();
    if (stopped != null) return stopped;
    let output = outputChunks.join("").trim();
    const doneEvent = events.findLast(
      (event): event is Extract<PromptEvent, { type: "done" }> => event.type === "done"
    );
    const turnStopReason = doneEvent?.stopReason;
    const promptSignals = signalsFromPromptEvents(events);
    const turnDurationMs = Date.now() - promptStartedAtMs;
    const errorEvents = events.filter(
      (event): event is Extract<PromptEvent, { type: "error" }> => event.type === "error"
    );
    const errorEvent = errorEvents.find((event) => classifyProviderFailure({
      agent: params.session.agent, ...event
    })?.code === "PROVIDER_AUTHENTICATION_REQUIRED") ?? errorEvents[0];
    const postTurnRecord = cursor != null && (errorEvent != null || exitCode !== 0 || exitSignal != null)
      ? await this.getRuntimeSessionRecord(params.session).catch(() => null)
      : null;
    stopped = stoppedTurn();
    if (stopped != null) return stopped;
    // Queue acknowledgement can be lost after dispatch. Only an explicit
    // pre-execution rejection plus unchanged submission state permits replay.
    // A normal "agent needs reconnect" banner is not a failure signal at all.
    if (errorEvents.length === 1 && errorEvent?.origin === "queue" &&
        SAFE_PRE_DISPATCH_QUEUE_REJECTIONS.has(errorEvent.detailCode ?? "") &&
        errorEvent.retryable !== false && exitSignal == null && exitCode != null &&
        params.retryAfterReconnect !== true &&
        outputChunks.length === 0 && latestNormalizedUsage == null &&
        events.every((event) => event.type === "error" || event.type === "status") &&
        isRuntimeSubmissionUnchanged(cursor, postTurnRecord)) {
      const providerFailure = classifyProviderFailure({ agent: params.session.agent, ...errorEvent });
      if (providerFailure?.code !== "PROVIDER_AUTHENTICATION_REQUIRED") {
        await this.waitForRuntimeSessionReady({
          name: params.session.name,
          agent: params.session.agent,
          directory: params.session.directory,
          ...(params.session.modelProvider != null
            ? { modelProvider: params.session.modelProvider }
            : {})
        });
        stopped = stoppedTurn();
        if (stopped != null) return stopped;
        // Re-check after waiting: another producer may have submitted meanwhile.
        const readyRecord = await this.getRuntimeSessionRecord(params.session).catch(() => null);
        stopped = stoppedTurn();
        if (stopped != null) return stopped;
        if (isRuntimeSubmissionUnchanged(cursor, readyRecord)) {
          return await this.runRuntimeTurn({
            session: params.session,
            promptText: params.promptText,
            permissionMode: params.permissionMode,
            ...(params.interactionMode != null ? { interactionMode: params.interactionMode } : {}),
            retryAfterReconnect: true
          });
        }
      }
    }
    const currentDiagnostic = output || extractCurrentTurnAgentText(postTurnRecord, cursor, params.promptText);
    const nativeAuthFailure = params.session.agent === "claude" && currentDiagnostic != null &&
      /^Failed to authenticate:/u.test(currentDiagnostic.trim())
      ? classifyProviderFailure({ agent: "claude", message: currentDiagnostic }) : null;
    if (nativeAuthFailure != null) {
      await this.deps.outputRouter.onError(
        params.session.name,
        new PuppenclawError(nativeAuthFailure.code, nativeAuthFailure.message),
        { code: nativeAuthFailure.code, retryable: nativeAuthFailure.retryable }
      );
      this.completeActiveTurnOutput(params.session.name);
      return failedProviderTurn(nativeAuthFailure);
    }
    if (errorEvent != null) {
      const safeErrorMessage = sanitizeActiveTurnText(errorEvent.message);
      this.deps.logger.warn(
        `ACPX session ${params.session.name} returned error event: ${safeErrorMessage}`
      );
      const providerFailure = classifyProviderFailure({
        agent: params.session.agent,
        ...(errorEvent.code != null ? { code: errorEvent.code } : {}),
        // Classify before redaction can hide an OAuth invalid_grant marker.
        // Only the classifier's fixed public message crosses this boundary.
        message: errorEvent.message,
        ...(errorEvent.retryable != null ? { retryable: errorEvent.retryable } : {})
      });
      if (providerFailure != null) {
        await this.deps.outputRouter.onError(
          params.session.name,
          new PuppenclawError(providerFailure.code, providerFailure.message),
          { code: providerFailure.code, retryable: providerFailure.retryable }
        );
        this.completeActiveTurnOutput(params.session.name);
        return failedProviderTurn(providerFailure);
      }
      await this.deps.outputRouter.onError(params.session.name, new Error(safeErrorMessage), {
        ...(errorEvent.code != null ? { code: errorEvent.code } : {}),
        ...(errorEvent.retryable != null ? { retryable: errorEvent.retryable } : {})
      });
      this.completeActiveTurnOutput(params.session.name);
      return {
        output: safeErrorMessage,
        warnings: [],
        transcript: [
          {
            role: "status",
            text: safeErrorMessage,
            createdAt: nowIso()
          }
        ],
        state: "failed"
      };
    }
    // ACPX reports PERMISSION_DENIED (5) even when Claude completed a plan
    // after the read-only boundary selected "No, keep planning". Accept only
    // a complete current invocation whose final permission holds a plan and
    // whose other permissions were also denied. No denied tool is replayed.
    const planCompletionContext = {
      exitCode,
      signal: exitSignal,
      ...(params.interactionMode != null ? { interactionMode: params.interactionMode } : {}),
      permissionMode: params.permissionMode,
      hasFreshOutput: output.length > 0,
      hasError: errorEvents.length > 0
    };
    const completedPlanBoundary = params.session.agent === "claude" && planPermissions.allowsCompletedPlan(planCompletionContext);
    const planHandoff = params.session.agent === "claude"
      ? planPermissions.completedPlanHandoff(planCompletionContext) : undefined;
    if ((exitCode !== 0 || exitSignal != null) && !completedPlanBoundary) {
      const message = sanitizeActiveTurnText(
        stderr.trim() || `acpx exited with code ${exitCode ?? "unknown"}${exitSignal != null ? ` (${exitSignal})` : ""}`
      );
      this.deps.logger.warn(
        `ACPX session ${params.session.name} exited with code ${exitCode ?? "unknown"}: ${message}`
      );
      const providerFailure = classifyProviderFailure({
        agent: params.session.agent,
        message: stderr.trim() || message
      });
      if (providerFailure != null) {
        await this.deps.outputRouter.onError(
          params.session.name,
          new PuppenclawError(providerFailure.code, providerFailure.message),
          { code: providerFailure.code, retryable: providerFailure.retryable }
        );
        this.completeActiveTurnOutput(params.session.name);
        return failedProviderTurn(providerFailure);
      }
      await this.deps.outputRouter.onError(params.session.name, new Error(message));
      this.completeActiveTurnOutput(params.session.name);
      return {
        output: message,
        warnings: [],
        transcript: [
          {
            role: "status",
            text: message,
            createdAt: nowIso()
          }
        ],
        state: "failed"
      };
    }

    if (doneEvent == null) {
      const message = "ACP runtime ended without confirming completion of the current turn; partial work may have been saved.";
      await this.deps.outputRouter.onError(params.session.name, new PuppenclawError("ACP_TURN_INCOMPLETE", message), {
        code: "ACP_TURN_INCOMPLETE", retryable: false
      });
      this.completeActiveTurnOutput(params.session.name);
      return {
        output: message,
        outputRole: "status",
        warnings: [],
        transcript: [{ role: "status", text: message, createdAt: nowIso() }],
        state: "failed",
        failureCode: "ACP_TURN_INCOMPLETE",
        retryable: false,
        durationMs: turnDurationMs,
        ...(latestTokenUsage != null ? { tokenUsage: latestTokenUsage } : {}),
        ...(latestNormalizedUsage != null ? { usage: latestNormalizedUsage } : {})
      };
    }
    // The same invocation must have emitted its terminal completion before any
    // persisted text can supplement missing streamed output. History text alone
    // is never proof of completion, even when its submission is identifiable.
    if (output.length === 0 && cursor != null) {
      output = await this.waitForDelayedAssistantOutput({
        session: params.session,
        cursor,
        promptText: params.promptText
      }) ?? "";
      stopped = stoppedTurn();
      if (stopped != null) return stopped;
      const recoveredAuthFailure = params.session.agent === "claude" && /^Failed to authenticate:/u.test(output)
        ? classifyProviderFailure({ agent: "claude", message: output }) : null;
      if (recoveredAuthFailure != null) {
        await this.deps.outputRouter.onError(params.session.name,
          new PuppenclawError(recoveredAuthFailure.code, recoveredAuthFailure.message),
          { code: recoveredAuthFailure.code, retryable: recoveredAuthFailure.retryable });
        this.completeActiveTurnOutput(params.session.name);
        return failedProviderTurn(recoveredAuthFailure);
      }
    }
    stopped = stoppedTurn();
    if (stopped != null) return stopped;
    const completedSignals = planHandoff != null
      ? mergeTurnSignals(signalsFromPromptEvents(events, true), { nativeMode: "plan", plan: { ...promptSignals?.plan, source: "claude-tool" } })
      : promptSignals;
    if (planHandoff?.text != null && completedSignals?.inputRequest == null) {
      // The adapter calls its automatic read-only hold a user rejection.
      // Publish the actual offered plan, never that invented human decision.
      output = sanitizeActiveTurnText(planHandoff.text);
    }
    const result = await this.finishSuccessfulTurn({
      sessionName: params.session.name,
      output,
      ...(completedSignals != null ? { signals: completedSignals } : {}),
      ...(latestTokenUsage != null ? { tokenUsage: latestTokenUsage } : {}),
      ...(latestNormalizedUsage != null ? { usage: latestNormalizedUsage } : {}),
      ...(turnStopReason != null ? { stopReason: turnStopReason } : {}),
      durationMs: turnDurationMs
    });
    if (planHandoff != null && completedSignals?.inputRequest == null) {
      if (planHandoff.deniedToolRequests != null) {
        result.warnings.push(`${planHandoff.deniedToolRequests} earlier tool permission request(s) were denied during planning. Those denials remain in the diagnostics; execution is still disabled.`);
      }
      result.warnings.push("Plan completed. The read-only planning boundary kept execution disabled; the plan is awaiting user approval.");
      this.deps.logger.info(`ACPX session ${params.session.name} completed a plan after ${planPermissions.deniedPlanRequests} keep-planning permission response(s); exit code ${exitCode} retained in process diagnostics.`);
    }
    this.completeActiveTurnOutput(params.session.name);
    return result;
  }

  private async runCodexOneShotTurn(params: {
    session: SessionInfo;
    promptText: string;
    permissionMode: PermissionMode;
    interactionMode?: InteractionMode;
  }): Promise<TurnResult> {
    const subagents = params.session.modelProvider?.subagents;
    if (
      subagents != null &&
      params.session.model != null &&
      params.session.model !== params.session.modelProvider?.model
    ) {
      // Without `-m` the wrapper runs the provider's model; refuse rather than
      // silently dropping a different requested session model.
      throw new PuppenclawError(
        "MODEL_PROVIDER_SUBAGENT_POLICY_CONFLICT",
        "A Codex session with a local subagent policy must use its model provider's model."
      );
    }
    const tmpDir = join(params.session.directory, ".puppenclaw", "tmp");
    await mkdir(tmpDir, { recursive: true });
    const outputPath = join(
      tmpDir,
      `${params.session.name.replace(/[^A-Za-z0-9._-]+/gu, "_")}-${Date.now()}-last-message.txt`
    );
    const providerLauncher = this.deps.config.agentCommands.codex?.trim() ?? "codex";
    const providerLauncherParts = splitCommandLine(providerLauncher);
    const codexArgs = [
      "exec",
      "--cd",
      params.session.directory,
      "--skip-git-repo-check",
      ...buildCodexPermissionArgs(params.permissionMode),
      "--json",
      "--output-last-message",
      outputPath,
      ...buildCodexModelArgs(params.session),
      "-"
    ];
    const codexCommand = this.deps.config.codexCommand?.trim();
    const directCommandArgs =
      codexCommand != null
        ? ["--cwd", params.session.directory, "--", ...providerLauncherParts, ...codexArgs]
        : codexArgs;
    const spawnCommand = resolveSpawnCommand(codexCommand ?? providerLauncher, directCommandArgs);
    const runtimeEnv = this.modelProviderRuntimeEnv(params.session.modelProvider, params.session.name);
    const env = {
      ...withoutInheritedCodexSubagentPolicy(process.env),
      ...(runtimeEnv ?? {}),
      // Replaces the `-c model_reasoning_effort` override omitted above.
      ...(subagents != null && params.session.runtimeEffort != null
        ? { PUPPENCLAW_MODEL_PROVIDER_REASONING_EFFORT: params.session.runtimeEffort }
        : {}),
      // Derived only from Puppenclaw's validated turn controls. The Codex
      // wrapper converts this out-of-band value into trusted model
      // instructions, so user prompt text cannot elevate a planning turn.
      PUPPENCLAW_CODEX_TURN_POLICY: deriveCodexTurnPolicy(
        params.interactionMode,
        params.permissionMode
      ),
      PUPPENCLAW_DIRECT_CODEX_AGENT_COMMAND:
        process.env.PUPPENCLAW_DIRECT_CODEX_AGENT_COMMAND ?? process.env.CODEX_EXECUTABLE ?? "codex"
    };

    await this.startActiveTurnOutput(params.session);
    this.assertTurnWasNotStopped(params.session.name);
    const runnerTurnId = this.activeTurnIds.get(params.session.name)!;
    const diagnostic = await TurnDiagnosticsRecorder.start({
      rootDir: this.deps.store.rootDir,
      sessionName: params.session.name,
      turnId: runnerTurnId,
      agent: params.session.agent,
      secretValues: Object.entries(env)
        .filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL/u.test(key) && typeof value === "string" && value.length >= 6)
        .map(([, value]) => value as string),
      onError: (error) => this.deps.logger.warn(error.message)
    }).catch(() => {
      this.deps.logger.warn(`Private turn diagnostics unavailable for ${params.session.name}.`);
      return undefined;
    });
    try {
    const child = spawnCommand.shell
      ? spawn(spawnCommand.command, {
          cwd: params.session.directory,
          stdio: ["pipe", "pipe", "pipe"],
          shell: true,
          detached: process.platform !== "win32",
          env
        })
      : spawn(spawnCommand.command, spawnCommand.args, {
          cwd: params.session.directory,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          env
        });
    this.deps.runners?.track(child, { kind: "turn", sessionName: params.session.name });
    const exit = childExit(child);
    void exit.catch(() => undefined);
    await this.registerActiveTurnProcess(params.session.name, child);

    let stderr = "";
    let pendingStdout = "";
    let liveOutputChunks = 0;
    const dispatchTasks: Array<Promise<void>> = [];
    const events = new CodexEventAdapter();
    let modelUsageGroups: ModelUsageGroup[] | undefined;
    // Wrapper metadata shares the protocol channel but is never a Codex event:
    // it reaches neither the transcript/ACP stream nor diagnostics.
    const consumeWrapperMetadata = (event: JsonRecord): void => {
      const groups = event.type === OCSL_MODEL_USAGE_TYPE ? parseOcslModelUsage(event) : null;
      if (groups == null) {
        this.deps.logger.debug(
          `Ignored invalid or unknown Codex wrapper metadata for session ${params.session.name}.`
        );
        return;
      }
      modelUsageGroups = groups; // the last valid line wins
      try {
        this.deps.statistics?.observeModelUsage(params.session.name, groups, {
          localWorkers: subagents != null
        });
      } catch (error) {
        this.deps.logger.warn(
          `Unable to record per-model statistics for ${params.session.name}: ${ensureError(error).message}`
        );
      }
    };
    const appendLiveOutput = (text: string): void => {
      const sanitized = sanitizeActiveTurnText(text);
      if (sanitized.length === 0) {
        return;
      }
      liveOutputChunks += 1;
      this.appendActiveTurnOutput(params.session.name, sanitized);
      dispatchTasks.push(this.deps.outputRouter.onChunk(params.session.name, sanitized));
    };
    const consumeStdoutLine = (line: string): void => {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) {
          return;
        }
        if (isWrapperMetadataType(parsed.type)) {
          consumeWrapperMetadata(parsed);
          return;
        }
        this.deps.statistics?.observeEvent(params.session.name, parsed, "codex");
        diagnostic?.observeEvent(parsed);
        const update = events.consume(parsed);
        for (const activity of update.activities) {
          dispatchTasks.push(this.deps.outputRouter.onActivity(params.session.name, activity));
        }
        const visibleText = update.assistantText;
        if (visibleText != null && visibleText.length > 0) {
          appendLiveOutput(visibleText);
        }
      } catch {
        diagnostic?.observeEvent({ type: "malformed_json" });
        // `codex exec --json` stdout is a protocol channel. Never turn an
        // unparsable record into assistant prose: it may contain raw tool
        // arguments, tool output, or credentials from a broken relay.
        this.deps.logger.debug(
          `Ignored malformed Codex JSON event for session ${params.session.name}.`
        );
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pendingStdout += chunk;
      while (true) {
        const newlineIndex = pendingStdout.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }
        const line = pendingStdout.slice(0, newlineIndex).trim();
        pendingStdout = pendingStdout.slice(newlineIndex + 1);
        if (line.length > 0) {
          consumeStdoutLine(line);
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-65_536);
      diagnostic?.observeStderr(chunk);
    });

    // See runTurn: an early child exit must not turn the prompt write EPIPE
    // into an uncaught exception.
    child.stdin.on("error", (error: Error) => {
      this.deps.logger.debug(
        `Orchestrator prompt stdin error for ${params.session.name}: ${error.message}`
      );
    });
    child.stdin.setDefaultEncoding("utf8");
    child.stdin.write(buildCodexPermissionPrompt(params.promptText, params.permissionMode));
    child.stdin.end();

    const { code: exitCode, signal: exitSignal } = await exit.catch(async (error) => {
      await diagnostic?.finish({ exitCode: null, signal: null, outcome: "failed", reasonCode: "CODEX_TURN_FAILED" }).catch(() => {});
      this.setActiveTurnOutput(params.session.name, `\n[error] ${ensureError(error).message}\n`);
      this.completeActiveTurnOutput(params.session.name);
      throw normalizeProviderError(
        params.session,
        new PuppenclawError("CODEX_TURN_FAILED", ensureError(error).message)
      );
    });

    const trailingStdoutLine = pendingStdout.trim();
    if (trailingStdoutLine.length > 0) {
      consumeStdoutLine(trailingStdoutLine);
    }
    await Promise.all(dispatchTasks);

    let finalReadError: unknown;
    const finalOutput = (await readCodexFinalMessageFile(outputPath).catch((error: unknown) => {
      finalReadError = error;
      return "";
    })).trim();
    await diagnostic?.recordFinalFile(outputPath, finalReadError);
    await unlinkCodexFinalMessageFile(outputPath);
    const liveOutput = this.activeTurnOutputs.get(params.session.name)?.text.trim() ?? "";
    const canonicalFinalOutput = sanitizeActiveTurnText(finalOutput);
    const combinedOutput = canonicalFinalOutput || (events.terminalStatus === "completed" ? events.finalAnswer : undefined) || "";
    const modelUsage: TurnModelUsage | undefined = modelUsageGroups == null
      ? undefined
      : {
          turnId: runnerTurnId,
          localWorkers: subagents != null,
          entries: modelUsageGroups.map((group) => ({
            role: group.role,
            model: group.model,
            threads: group.threads,
            usage: normalizeModelUsageGroup(group)
          }))
        };
    // The wrapper line already includes the main thread: it replaces, never
    // adds to, the main-thread usage from Codex events.
    const latestCodexUsage = modelUsage != null
      ? sumNormalizedUsage(modelUsage.entries.map((entry) => entry.usage))
      : events.latestUsage;
    const modelUsageResult = modelUsage != null ? { modelUsage } : {};
    const stopped = this.stopRequests.has(params.session.name) || this.deps.store.getSession(params.session.name)?.state === "stopped";
    const nativeFailed = exitCode !== 0 || exitSignal != null || events.terminalStatus === "failed";
    await diagnostic?.finish({
      exitCode,
      signal: exitSignal,
      outcome: stopped ? "stopped" : nativeFailed || !combinedOutput ? "failed" : "completed",
      ...(nativeFailed ? { reasonCode: "CODEX_TURN_FAILED" } : !combinedOutput ? { reasonCode: "NO_FINAL_MESSAGE" } : {})
    }).catch(() => this.deps.logger.warn(`Unable to finalize private diagnostics for ${params.session.name}.`));

    // A stop is an intentional cancellation, not an unexpected process fault.
    // The lifecycle persistence path keeps the stopped state and partial usage.
    if (stopped) {
      this.completeActiveTurnOutput(params.session.name);
      return {
        output: "Turn stopped by user.",
        outputRole: "status",
        warnings: [],
        transcript: [{ role: "status", text: "Turn stopped by user.", createdAt: nowIso() }],
        state: "stopped",
        ...(latestCodexUsage != null ? { usage: latestCodexUsage } : {}),
        ...modelUsageResult
      };
    }

    if (nativeFailed) {
      const message = sanitizeActiveTurnText(
        exitSignal != null
          ? `Codex was terminated by ${exitSignal}.`
          : events.failureMessage || stderr.trim() || `Codex exited with code ${exitCode ?? "unknown"}.`
      );
      this.deps.logger.warn(
        `Codex session ${params.session.name} failed (exit ${exitCode ?? "unknown"}, signal ${exitSignal ?? "none"}): ${message}`
      );
      const failureOutput = [liveOutput, `\n[error] ${message}\n`]
        .filter((part) => part.trim().length > 0)
        .join("\n");
      this.setActiveTurnOutput(params.session.name, failureOutput);
      const providerFailure = classifyProviderFailure({
        agent: params.session.agent,
        message
      });
      if (providerFailure != null) {
        await this.deps.outputRouter.onError(
          params.session.name,
          new PuppenclawError(providerFailure.code, providerFailure.message),
          { code: providerFailure.code, retryable: providerFailure.retryable }
        );
        this.completeActiveTurnOutput(params.session.name);
        return {
          ...failedProviderTurn(providerFailure),
          ...(latestCodexUsage != null ? { usage: latestCodexUsage } : {}),
          ...modelUsageResult
        };
      }
      await this.deps.outputRouter.onError(params.session.name, new Error(message));
      this.completeActiveTurnOutput(params.session.name);
      return {
        output: message,
        warnings: [],
        transcript: [
          {
            role: "status",
            text: message,
            createdAt: nowIso()
          }
        ],
        state: "failed",
        failureCode: "CODEX_TURN_FAILED",
        retryable: false,
        ...(latestCodexUsage != null ? { usage: latestCodexUsage } : {}),
        ...modelUsageResult
      };
    }

    if (combinedOutput.length === 0) {
      this.deps.logger.warn(
        `Codex session ${params.session.name} exited with code ${exitCode} without a final assistant message (--output-last-message ${finalOutput.length > 0 ? "sanitized to empty" : "empty or missing"}, ${liveOutputChunks} live chunks, ${stderr.trim().length} stderr chars).`
      );
    }
    if (combinedOutput.length > 0) {
      const activeText = this.activeTurnOutputs.get(params.session.name)?.text ?? "";
      if (activeText.trim().length === 0) {
        this.appendActiveTurnOutput(params.session.name, combinedOutput);
        await this.deps.outputRouter.onChunk(params.session.name, combinedOutput);
      } else if (
        canonicalFinalOutput.length > 0 &&
        !activeText.includes(
          canonicalFinalOutput.slice(0, Math.min(canonicalFinalOutput.length, 240))
        )
      ) {
        const finalChunk = `\n\n${canonicalFinalOutput}`;
        this.appendActiveTurnOutput(params.session.name, finalChunk);
        await this.deps.outputRouter.onChunk(params.session.name, finalChunk);
      }
    }
    const result = await this.finishSuccessfulTurn({
      sessionName: params.session.name,
      output: combinedOutput,
      ...(latestCodexUsage != null ? { usage: latestCodexUsage } : {})
    });
    this.completeActiveTurnOutput(params.session.name);
    return { ...result, ...modelUsageResult };
    } finally {
      diagnostic?.close();
    }
  }

  private async startActiveTurnOutput(session: SessionInfo): Promise<void> {
    const sessionName = session.name;
    this.assertTurnWasNotStopped(sessionName);
    await this.deps.statistics?.beginSegment(session);
    const now = nowIso();
    const turnId = this.activeTurnIds.get(sessionName) ?? randomUUID();
    this.activeTurnIds.set(sessionName, turnId);
    this.activeTurnOutputs.set(sessionName, {
      sessionName,
      text: "",
      startedAt: now,
      updatedAt: now,
      complete: false,
      totalChars: 0
    });
    this.dirtyActiveTurnCheckpoints.delete(sessionName);
    const keyedExecution = this.keyedTurnExecutions.get(sessionName);
    const buildSession = (stored: SessionInfo | null): SessionInfo => {
      const current = stored ?? session;
      const {
        lastError: _lastError,
        failureCode: _failureCode,
        retryable: _retryable,
        ...healthy
      } = current;
      return {
        ...healthy,
        state: "running",
        lastActivity: now,
        activeTurn: {
          id: turnId,
          ...(keyedExecution != null
            ? {
                turnKey: keyedExecution.turnKey,
                requestFingerprint: keyedExecution.requestFingerprint
              }
            : {}),
          state: "running",
          startedAt: current.activeTurn?.id === turnId ? current.activeTurn.startedAt : now,
          updatedAt: now,
          outputChars: 0
        }
      };
    };
    if (keyedExecution == null) {
      await this.deps.store.upsertSession(buildSession(this.deps.store.getSession(sessionName)));
    } else {
      await this.deps.store.patchSessionAndLinkTurnRequest(
        sessionName,
        keyedExecution.turnKey,
        keyedExecution.requestFingerprint,
        buildSession
      );
    }
  }

  private assertTurnWasNotStopped(sessionName: string): void {
    if (this.stopRequests.has(sessionName)) {
      throw new PuppenclawError(
        "TURN_ABORTED",
        `Turn for session ${sessionName} was stopped before provider dispatch.`
      );
    }
  }

  private appendActiveTurnOutput(sessionName: string, text: string): void {
    const current = this.activeTurnOutputs.get(sessionName);
    if (current == null) {
      return;
    }
    const nextText = `${current.text}${text}`;
    const boundedText =
      nextText.length <= MAX_ACTIVE_TURN_OUTPUT_CHARS
        ? nextText
        : `[active output truncated: kept latest ${MAX_ACTIVE_TURN_OUTPUT_CHARS} chars]\n${nextText.slice(
            -MAX_ACTIVE_TURN_OUTPUT_CHARS
          )}`;
    this.activeTurnOutputs.set(sessionName, {
      ...current,
      text: boundedText,
      updatedAt: nowIso(),
      totalChars: current.totalChars + text.length
    });
    this.checkpointActiveTurnOutput(sessionName);
  }

  private setActiveTurnOutput(sessionName: string, text: string): void {
    const current = this.activeTurnOutputs.get(sessionName);
    if (current == null) {
      return;
    }
    const sanitized = sanitizeActiveTurnText(text);
    const boundedText =
      sanitized.length <= MAX_ACTIVE_TURN_OUTPUT_CHARS
        ? sanitized
        : `[active output truncated: kept latest ${MAX_ACTIVE_TURN_OUTPUT_CHARS} chars]\n${sanitized.slice(
            -MAX_ACTIVE_TURN_OUTPUT_CHARS
          )}`;
    this.activeTurnOutputs.set(sessionName, {
      ...current,
      text: boundedText,
      updatedAt: nowIso(),
      totalChars: sanitized.length
    });
    this.checkpointActiveTurnOutput(sessionName, true);
  }

  private completeActiveTurnOutput(sessionName: string): void {
    if (this.deferredControllerCompletions.has(sessionName)) return;
    const current = this.activeTurnOutputs.get(sessionName);
    if (current == null) {
      return;
    }
    this.activeTurnOutputs.set(sessionName, {
      ...current,
      updatedAt: nowIso(),
      complete: true
    });
  }

  private async registerActiveTurnProcess(
    sessionName: string,
    child: ChildProcess
  ): Promise<void> {
    const turnId = this.activeTurnIds.get(sessionName) ?? randomUUID();
    this.activeTurnIds.set(sessionName, turnId);
    this.activeTurnProcesses.set(sessionName, {
      child,
      turnId
    });
    const clear = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (this.activeTurnProcesses.get(sessionName)?.child === child) {
        this.activeTurnProcesses.delete(sessionName);
      }
      void this.patchActiveTurn(sessionName, turnId, (activeTurn) => ({
        ...activeTurn,
        updatedAt: nowIso(),
        exitCode,
        signal
      }));
    };
    // Register process lifecycle listeners synchronously. In particular, an
    // ENOENT spawn can emit `error` before the first awaited identity lookup;
    // delaying this listener would turn a durable keyed failure into an
    // uncaught process exception.
    child.once("close", clear);
    child.once("error", () => clear(child.exitCode, child.signalCode));
    const pid = child.pid;
    const identity = pid != null ? await readLinuxProcessIdentity(pid) : null;
    if (pid != null && identity != null) {
      this.deps.statistics?.registerRoot(this.deps.advanced?.parent(sessionName) ?? sessionName, { pid, startTicks: identity.processStartIdentity.split(":")[1]! });
    }
    await this.patchActiveTurn(sessionName, turnId, (activeTurn) => ({
      ...activeTurn,
      ...(pid != null ? { pid } : {}),
      ...(identity != null ? identity : {}),
      updatedAt: nowIso()
    }));
  }

  private checkpointActiveTurnOutput(sessionName: string, force = false): void {
    const output = this.activeTurnOutputs.get(sessionName);
    const turnId = this.activeTurnIds.get(sessionName);
    if (output == null || turnId == null) {
      this.dirtyActiveTurnCheckpoints.delete(sessionName);
      return;
    }
    if (!force) {
      this.dirtyActiveTurnCheckpoints.add(sessionName);
      this.scheduleActiveTurnCheckpoints();
      return;
    }
    this.dirtyActiveTurnCheckpoints.delete(sessionName);
    void this.patchActiveTurn(sessionName, turnId, (activeTurn) => ({
      ...activeTurn,
      updatedAt: output.updatedAt,
      lastOutputAt: output.updatedAt,
      outputChars: output.totalChars
    }));
  }

  /** One daemon-wide tick checkpoints every turn with new output in the same group commit. */
  private scheduleActiveTurnCheckpoints(): void {
    if (this.activeTurnCheckpointTimer != null) {
      return;
    }
    this.activeTurnCheckpointTimer = setTimeout(() => {
      this.activeTurnCheckpointTimer = null;
      const due = [...this.dirtyActiveTurnCheckpoints];
      this.dirtyActiveTurnCheckpoints.clear();
      for (const sessionName of due) {
        this.checkpointActiveTurnOutput(sessionName, true);
      }
    }, activeTurnCheckpointMs());
    this.activeTurnCheckpointTimer.unref?.();
  }

  private patchActiveTurn(
    sessionName: string,
    turnId: string,
    patch: (activeTurn: ActiveTurnMetadata) => ActiveTurnMetadata
  ): Promise<void> {
    const previous = this.activeTurnPersistence.get(sessionName) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await this.deps.store.patchSession(sessionName, (current) => {
          if (current?.activeTurn?.id !== turnId) {
            return current;
          }
          return {
            ...current,
            activeTurn: patch(current.activeTurn)
          };
        });
      });
    this.activeTurnPersistence.set(sessionName, next);
    const clear = (): void => {
      if (this.activeTurnPersistence.get(sessionName) === next) {
        this.activeTurnPersistence.delete(sessionName);
      }
    };
    void next.then(clear, clear);
    return next;
  }

  private async persistFinalTurnSession(
    sessionName: string,
    state: ActiveTurnLifecycleState,
    buildSession: (
      current: SessionInfo,
      activeTurn: ActiveTurnMetadata | undefined,
      stoppedDuringTurn: boolean
    ) => SessionInfo,
    error?: string,
    receiptOutcome?: Omit<TurnRequestSuccessOutcome, "session"> | TurnRequestErrorOutcome,
    failureMetadata?: { code: string; retryable?: boolean }
  ): Promise<SessionInfo> {
    await this.deps.advanced?.closeTurn(sessionName);
    const stoppedForStatistics = this.stopRequests.has(sessionName) || this.deps.store.getSession(sessionName)?.state === "stopped";
    await this.deps.statistics?.settle(sessionName, stoppedForStatistics ? "cancelled" : state === "failed" ? "failed" : "completed");
    this.checkpointActiveTurnOutput(sessionName, true);
    await this.activeTurnPersistence.get(sessionName)?.catch(() => undefined);
    const turnId = this.activeTurnIds.get(sessionName);
    const completedAt = nowIso();
    const patchSession = (current: SessionInfo | null): SessionInfo => {
      if (current == null) {
        throw new PuppenclawError("NO_SESSION", `Unknown session ${sessionName}.`);
      }
      const stoppedDuringTurn = current.state === "stopped" || this.stopRequests.has(sessionName);
      const finalLifecycleState = stoppedDuringTurn ? "stopped" : state;
      const activeTurn =
        turnId != null && current.activeTurn?.id === turnId
          ? {
              ...current.activeTurn,
              state: finalLifecycleState,
              updatedAt: completedAt,
              completedAt,
              ...(error != null && error.trim().length > 0 ? { error } : {}),
              ...(failureMetadata != null
                ? {
                    failureCode: failureMetadata.code,
                    ...(failureMetadata.retryable != null
                      ? { retryable: failureMetadata.retryable }
                      : {})
                  }
                : {})
            }
          : current.activeTurn;
      let built = buildSession(current, activeTurn, stoppedDuringTurn);
      if (!stoppedDuringTurn && built.state !== "failed") {
        const {
          lastError: _lastError,
          failureCode: _failureCode,
          retryable: _retryable,
          ...healthy
        } = built;
        built = healthy;
        if (built.state !== "waiting_input") {
          const { pendingQuestion: _pendingQuestion, ...settled } = built;
          built = settled;
        }
      }
      if (!stoppedDuringTurn) {
        return built;
      }
      return {
        ...withoutRecoveryFence(withoutFocusLease(built)),
        state: "stopped",
        lastStopReason: current.lastStopReason ?? "stopped by user",
        ...(activeTurn != null ? { activeTurn } : {})
      };
    };
    const keyedExecution = this.keyedTurnExecutions.get(sessionName);
    const nextSession =
      keyedExecution != null && receiptOutcome != null
        ? await this.deps.store.patchSessionAndSettleTurnRequest(
            sessionName,
            keyedExecution.turnKey,
            keyedExecution.requestFingerprint,
            patchSession,
            receiptOutcome
          )
        : await this.deps.store.patchSession(sessionName, patchSession);
    this.stopRequests.delete(sessionName);
    this.activeTurnIds.delete(sessionName);
    this.dirtyActiveTurnCheckpoints.delete(sessionName);
    if (nextSession == null) {
      throw new PuppenclawError("NO_SESSION", `Unknown session ${sessionName}.`);
    }
    return nextSession;
  }

  /**
   * Signals the whole process TREE of the currently-registered turn process:
   * `taskkill /pid <pid> /T /F` on win32 (a plain child.kill would only hit
   * the cmd.exe shell wrapper and orphan the real agent process) and a
   * process-group kill on POSIX (the spawns set `detached: true`).
   *
   * When `expectedChild` is provided the kill is identity-guarded: it becomes
   * a no-op if the registered turn process is no longer that same child, so a
   * delayed escalation can never kill a newer turn's process.
   */
  private terminateActiveTurnProcess(
    sessionName: string,
    signal: NodeJS.Signals,
    expectedChild?: ChildProcess
  ): ChildProcess | null {
    const active = this.activeTurnProcesses.get(sessionName);
    if (active == null) {
      return null;
    }
    if (expectedChild != null && active.child !== expectedChild) {
      return null;
    }
    killProcessTree(active.child, signal, (error) => {
      this.deps.logger.warn(`Failed to signal active turn for ${sessionName}: ${error.message}`);
    });
    return active.child;
  }

  private async finishSuccessfulTurn(params: {
    sessionName: string;
    output: string;
    signals?: TurnSignals;
    tokenUsage?: TokenUsage;
    usage?: NormalizedUsage;
    stopReason?: string;
    durationMs?: number;
  }): Promise<TurnResult> {
    const signals = mergeTurnSignals(
      params.signals,
      params.stopReason != null ? { stopReason: params.stopReason } : undefined
    );
    const question =
      signals?.inputRequest?.text ??
      (signals?.inputRequest != null
        ? "Agent requested user input."
        : signals?.plan == null
          ? resolveQuestionFromOutput(params.output)
          : undefined);
    if (question == null && signals?.plan == null && params.output.trim().length === 0) {
      // A turn with no visible assistant output must never be
      // published as an assistant message: consumers holding only the
      // cumulative transcript would fall back to the previous assistant entry
      // and resurrect a stale reply as this turn's answer.
      this.deps.logger.warn(
        `Session ${params.sessionName} produced no final assistant message; publishing a failed status result.`
      );
      const statusSignals = mergeTurnSignals(signals, {
        stopReason: NO_FINAL_MESSAGE_STOP_REASON
      });
      await this.deps.outputRouter.onError(
        params.sessionName,
        new PuppenclawError("NO_FINAL_MESSAGE", NO_FINAL_MESSAGE_STATUS_TEXT),
        { code: "NO_FINAL_MESSAGE", retryable: false }
      );
      return {
        output: NO_FINAL_MESSAGE_STATUS_TEXT,
        outputRole: "status",
        ...(params.tokenUsage != null ? { tokenUsage: params.tokenUsage } : {}),
        ...(params.usage != null ? { usage: params.usage } : {}),
        stopReason: NO_FINAL_MESSAGE_STOP_REASON,
        ...(params.durationMs != null ? { durationMs: params.durationMs } : {}),
        ...(statusSignals != null ? { signals: statusSignals } : {}),
        warnings: [],
        transcript: [{ role: "status", text: NO_FINAL_MESSAGE_STATUS_TEXT, createdAt: nowIso() }],
        state: "failed",
        failureCode: "NO_FINAL_MESSAGE",
        retryable: false
      };
    }
    if (!this.deferredControllerCompletions.has(params.sessionName)) {
      await this.publishSuccessfulTurn(params.sessionName, params.output, question);
    }

    return {
      output: params.output,
      ...(question != null ? { question } : {}),
      ...(params.tokenUsage != null ? { tokenUsage: params.tokenUsage } : {}),
      ...(params.usage != null ? { usage: params.usage } : {}),
      ...(params.stopReason != null ? { stopReason: params.stopReason } : {}),
      ...(params.durationMs != null ? { durationMs: params.durationMs } : {}),
      ...(signals != null ? { signals } : {}),
      warnings: [],
      transcript: makeAssistantTranscript(params.output),
      state: question != null ? "waiting_input" : "idle"
    };
  }

  private async publishSuccessfulTurn(sessionName: string, output: string, question?: string): Promise<void> {
    await this.deps.outputRouter.onFinal(sessionName, output);
    if (question != null) await this.deps.outputRouter.onQuestion(sessionName, question);
    await this.deps.outputRouter.onComplete(sessionName,
      question != null ? "Turn completed and is waiting for user input." : "Turn completed.");
  }

  private async runControlCommand(params: {
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    allowNoSession?: boolean;
    timeoutMs?: number;
  }): Promise<ControlCommandResult> {
    return await new Promise<ControlCommandResult>((resolve, reject) => {
      const spawnCommand = resolveSpawnCommand(this.deps.config.acpxCommand ?? "acpx", params.args);
      const child = spawnCommand.shell
        ? spawn(spawnCommand.command, {
            cwd: params.cwd,
            stdio: ["ignore", "pipe", "pipe"],
            shell: true,
            detached: process.platform !== "win32",
            env: params.env != null ? { ...process.env, ...params.env } : process.env
          })
        : spawn(spawnCommand.command, spawnCommand.args, {
            cwd: params.cwd,
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
            env: params.env != null ? { ...process.env, ...params.env } : process.env
          });
      const sessionIndex = params.args.indexOf("--session");
      this.deps.runners?.track(child, {
        kind: "control",
        ...(sessionIndex >= 0 && params.args[sessionIndex + 1] != null
          ? { sessionName: params.args[sessionIndex + 1] }
          : {})
      });
      let settled = false;
      const timeout =
        params.timeoutMs == null
          ? null
          : setTimeout(() => {
              if (settled) {
                return;
              }
              settled = true;
              killProcessTreeWithEscalation(child, 250, (error) => {
                this.deps.logger.warn(
                  `Failed to stop timed-out ACP control command: ${error.message}`
                );
              });
              reject(
                new PuppenclawError(
                  "ACP_CONTROL_TIMEOUT",
                  `ACPX control command timed out after ${params.timeoutMs}ms.`
                )
              );
            }, params.timeoutMs);
      timeout?.unref();
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout != null) {
          clearTimeout(timeout);
        }
        reject(
          new PuppenclawError(
            "ACP_CONTROL_FAILED",
            `Failed running acpx command: ${ensureError(error).message}`
          )
        );
      });
      child.once("close", (exitCode: number | null) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout != null) {
          clearTimeout(timeout);
        }
        const events = parseJsonLines(stdout);
        const errorEvent = events.map((event) => toErrorRecord(event)).find(Boolean) ?? null;
        if (errorEvent != null && !(params.allowNoSession && errorEvent.code === "NO_SESSION")) {
          reject(new PuppenclawError(errorEvent.code ?? "ACP_CONTROL_FAILED", errorEvent.message));
          return;
        }
        if (
          (exitCode ?? 0) !== 0 &&
          !(params.allowNoSession && errorEvent?.code === "NO_SESSION")
        ) {
          reject(
            new PuppenclawError(
              "ACP_CONTROL_FAILED",
              stderr.trim() || `acpx exited with code ${exitCode ?? "unknown"}`
            )
          );
          return;
        }
        resolve({
          stdout,
          stderr,
          exitCode
        });
      });
    });
  }
}
