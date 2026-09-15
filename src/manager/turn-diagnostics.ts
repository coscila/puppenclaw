import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, basename, resolve, sep } from "node:path";
import { redactSensitiveText } from "../shared/utils.js";

export interface TurnDiagnosticsLimits {
  maxTurnBytes: number;
  maxSessionTurns: number;
  maxAgeMs: number;
  maxGlobalBytes: number;
}

export const TURN_DIAGNOSTICS_LIMITS: Readonly<TurnDiagnosticsLimits> = {
  maxTurnBytes: 1024 * 1024,
  maxSessionTurns: 10,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxGlobalBytes: 128 * 1024 * 1024,
};

interface StartOptions {
  rootDir: string;
  sessionName: string;
  turnId: string;
  agent: string;
  /** Errors in periodic persistence must not fail or interrupt a model turn. */
  onError?: (error: Error) => void;
  now?: () => number;
  flushIntervalMs?: number;
  /** May lower, but never raise, the production retention ceilings. */
  limits?: Partial<TurnDiagnosticsLimits>;
  /** Explicit credential values only; never provide or persist an env record. */
  secretValues?: readonly string[];
}

export interface TurnDiagnosticOutcome {
  exitCode: number | null;
  signal: string | null;
  outcome: "completed" | "failed" | "stopped";
  reasonCode?: string;
}

type EventSummary = {
  at: string;
  type: string;
  itemType?: string;
  status?: string;
  visibleTextCharacters?: number;
  errorCategory?: string;
};

const EVENT_TYPES = new Set([
  "thread.started", "turn.started", "turn.completed", "turn.failed",
  "turn.aborted", "turn.cancelled", "error", "item.started", "item.updated",
  "item.completed", "response_item", "token_count", "result",
  "response.completed", "response.failed", "response.incomplete",
  "session/update", "malformed_json",
]);
const ITEM_TYPES = new Set([
  "agent_message", "message", "reasoning", "command_execution", "file_change",
  "mcp_tool_call", "web_search", "todo_list", "error", "function_call",
  "function_call_output", "custom_tool_call", "custom_tool_call_output",
  "collab_agent_tool_call", "collab_agent_spawn", "collab_agent_wait",
]);
const STATUSES = new Set([
  "in_progress", "completed", "failed", "cancelled", "aborted", "incomplete",
]);
const SIGNALS = new Set([
  "SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGBUS",
  "SIGFPE", "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM",
  "SIGTERM", "SIGXCPU", "SIGXFSZ", "SIGSYS",
]);
const REASONS = new Set([
  "no_final_message", "NO_FINAL_MESSAGE", "CODEX_TURN_FAILED", "RUNNER_FAILURE",
  "provider_error", "spawn_error", "turn_failed", "cancelled", "aborted",
  "end_turn", "max_tokens", "context_length_exceeded", "signal", "exit_code",
]);
const HASH_NAME = /^[a-f0-9]{64}$/u;
const RECORD_NAME = /^[a-f0-9]{64}\.json$/u;
const TEMP_NAME = /^\.[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/u;
const MAX_EVENT_TAIL = 128;
const MAX_STDERR_LINES = 64;
const MAX_PENDING_STDERR = 4096;
const activeRecorders = new Map<string, Set<TurnDiagnosticsRecorder>>();

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sessionHash(sessionName: string): string {
  return hash(`puppenclaw-turn-diagnostics-v1:${sessionName}`);
}

function limitOptions(input: Partial<TurnDiagnosticsLimits> = {}): TurnDiagnosticsLimits {
  const result = { ...TURN_DIAGNOSTICS_LIMITS };
  for (const key of Object.keys(result) as Array<keyof TurnDiagnosticsLimits>) {
    const value = input[key];
    if (value != null) {
      if (!Number.isSafeInteger(value) || value < (key === "maxTurnBytes" ? 1024 : 1)) {
        throw new Error(`Invalid turn diagnostics limit: ${key}`);
      }
      result[key] = Math.min(value, result[key]);
    }
  }
  return result;
}

function errorCode(error: unknown): string {
  const code = record(error)?.code;
  return typeof code === "string" && /^E[A-Z0-9]{1,24}$/u.test(code) ? code : "UNKNOWN";
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function counter(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value);
}

function diagnosticCategory(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Never persist an error's free-form message: upstream errors can echo the
  // entire request, including prompts, tool payloads and authentication data.
  const text = redactSensitiveText(value.slice(0, MAX_PENDING_STDERR));
  if (/context.{0,30}(?:length|window|limit)|too many tokens/iu.test(text)) return "context_limit";
  if (/rate.?limit|\b429\b/iu.test(text)) return "rate_limit";
  if (/unauthori[sz]ed|invalid.{0,20}(?:key|token)|\b401\b/iu.test(text)) return "authentication";
  if (/forbidden|permission denied|\b403\b|EACCES|EPERM/iu.test(text)) return "permission_denied";
  if (/time.?out|ETIMEDOUT/iu.test(text)) return "timeout";
  if (/ECONNREFUSED|connection refused/iu.test(text)) return "connection_refused";
  if (/ENOTFOUND|EAI_AGAIN|resolve host|name resolution/iu.test(text)) return "dns_failure";
  if (/disconnect|ECONNRESET|EPIPE|broken pipe/iu.test(text)) return "connection_interrupted";
  if (/no (?:last|final) (?:agent|assistant) message|last.message.*empty/iu.test(text)) return "no_final_message";
  if (/cancel|abort|interrupt/iu.test(text)) return "interrupted";
  if (/out of memory|ENOMEM|oom.?kill/iu.test(text)) return "memory_exhaustion";
  if (/ENOSPC|no space left/iu.test(text)) return "disk_full";
  if (/parse|malformed|invalid json|protocol/iu.test(text)) return "protocol_error";
  if (/\b(?:500|502|503|504)\b|internal server error|service unavailable/iu.test(text)) return "upstream_server_error";
  if (/warn|error|fail/iu.test(text)) return "unspecified_diagnostic";
  return undefined;
}

function safeDiagnosticLine(value: string, secrets: readonly string[]): string | undefined {
  const clean = value.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "").trim();
  // Preserve recognisable runtime diagnostics, including novel error reasons,
  // but not arbitrary stderr text (a provider may dump a whole model request).
  if (!/^(?:(?:\d{4}-\d{2}-\d{2}T\S+\s+)?(?:ERROR|WARN|WARNING|FATAL|PANIC)\b|(?:\w*Error|warning)\s*:|Failed to\b|thread\s+.{0,80}\s+panicked\b|Caused by\s*:)/iu.test(clean)) return undefined;
  let scrubbed = clean;
  for (const secret of secrets) scrubbed = scrubbed.replaceAll(secret, "[redacted]");
  return redactSensitiveText(scrubbed)
    .replace(/(\b(?:set-cookie|cookie|x-auth-token)\s*[:=]\s*)[^\r\n]+/giu, "$1[redacted]")
    .replace(/(\b(?:authorization|proxy-authorization)\s*[:=]\s*)(?:bearer|basic)\s+\S+/giu, "$1[redacted]")
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/giu, "$1?[query withheld]")
    .replace(/\b(?:prompt|reasoning|tool[_ -]?(?:arguments|output|input|result)|environment(?: variables)?)\b[\s\S]*/iu, "[payload withheld]")
    .replace(/\b(?:request|response|body|messages?|tools?|arguments|env|input|output)\s*[:=][\s\S]*/iu, "[payload withheld]")
    .replace(/\b(?:raw|original|full)\s+(?:request|response|input|output)\b[\s\S]*/iu, "[payload withheld]")
    .replace(/[\[{]\s*["'{][\s\S]*/u, "[payload withheld]")
    .slice(0, 512);
}

/**
 * Pin every parent directory, then operate relative to its descriptor. This
 * Linux runner must not follow symlinks, including a parent replaced during a
 * write or purge. Ordinary lstat(path) followed by open(path) is insufficient.
 * The diagnostics are private controller data, never workspace-mounted data.
 */
function pinDirectory(path: string): number {
  if (process.platform !== "linux") {
    throw new Error("Private turn diagnostics require Linux descriptor-relative filesystem access.");
  }
  let fd = openSync(sep, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of resolve(path).split(sep).filter(Boolean)) {
      const next = openSync(at(fd, component), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function at(fd: number, name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error("Invalid diagnostics path component.");
  }
  return `/proc/self/fd/${fd}/${name}`;
}

function privateChild(parent: number, name: string, create: boolean): number {
  if (create) {
    try { mkdirSync(at(parent, name), { mode: 0o700 }); }
    catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
  }
  const fd = openSync(at(parent, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (fstatSync(fd).uid !== process.geteuid?.()) throw new Error("Diagnostics directory is not owned by this process user.");
    fchmodSync(fd, 0o700);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function pinRoot(rootDir: string, create: boolean): number {
  const store = pinDirectory(rootDir);
  try { return privateChild(store, "diagnostics", create); }
  finally { closeSync(store); }
}

type StoredFile = { session: string; name: string; size: number; mtime: number };

function inspectFiles(root: number): StoredFile[] {
  const files: StoredFile[] = [];
  for (const session of readdirSync(`/proc/self/fd/${root}`)) {
    if (!HASH_NAME.test(session)) continue;
    let directory: number;
    try { directory = privateChild(root, session, false); }
    catch { continue; } // Never follow a planted symlink or recurse elsewhere.
    try {
      for (const name of readdirSync(`/proc/self/fd/${directory}`)) {
        if (!RECORD_NAME.test(name) && !TEMP_NAME.test(name)) continue;
        const stat = lstatSync(at(directory, name));
        if (stat.isFile() && stat.nlink === 1) {
          files.push({ session, name, size: stat.size, mtime: stat.mtimeMs });
        }
      }
    } finally { closeSync(directory); }
  }
  return files.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
}

function removeFile(root: number, file: StoredFile): void {
  const directory = privateChild(root, file.session, false);
  try { unlinkSync(at(directory, file.name)); }
  finally { closeSync(directory); }
  try { rmdirSync(at(root, file.session)); }
  catch (error) { if (errorCode(error) !== "ENOTEMPTY" && errorCode(error) !== "EEXIST") throw error; }
}

/** Enforce retention without opening any record body or following any symlink. */
export async function pruneTurnDiagnostics(
  rootDir: string,
  options: { now?: number; limits?: Partial<TurnDiagnosticsLimits> } = {},
): Promise<void> {
  const limits = limitOptions(options.limits);
  let root: number;
  try { root = pinRoot(rootDir, false); }
  catch (error) { if (errorCode(error) === "ENOENT") return; throw error; }
  try {
    const counts = new Map<string, number>();
    let bytes = 0;
    const cutoff = (options.now ?? Date.now()) - limits.maxAgeMs;
    for (const file of inspectFiles(root)) {
      const count = counts.get(file.session) ?? 0;
      if (TEMP_NAME.test(file.name) || file.mtime < cutoff || file.size > limits.maxTurnBytes ||
          count >= limits.maxSessionTurns || bytes + file.size > limits.maxGlobalBytes) {
        removeFile(root, file);
      } else {
        counts.set(file.session, count + 1);
        bytes += file.size;
      }
    }
  } finally { closeSync(root); }
}

/** Permanent session deletion also fences live recorders against resurrection. */
export async function purgeSessionDiagnostics(rootDir: string, sessionName: string): Promise<void> {
  const session = sessionHash(sessionName);
  const key = `${resolve(rootDir)}:${session}`;
  for (const recorder of [...(activeRecorders.get(key) ?? [])]) recorder.close();
  let root: number;
  try { root = pinRoot(rootDir, false); }
  catch (error) { if (errorCode(error) === "ENOENT") return; throw error; }
  try {
    let directory: number;
    try { directory = privateChild(root, session, false); }
    catch (error) { if (errorCode(error) === "ENOENT") return; throw error; }
    try {
      for (const name of readdirSync(`/proc/self/fd/${directory}`)) {
        // Only this store's leaf records are in scope. Do not recursively
        // delete unexpected directories or unrelated data after corruption.
        if (!RECORD_NAME.test(name) && !TEMP_NAME.test(name)) continue;
        if (lstatSync(at(directory, name)).isDirectory()) continue;
        unlinkSync(at(directory, name));
      }
    } finally { closeSync(directory); }
    rmdirSync(at(root, session));
  } finally { closeSync(root); }
}

export class TurnDiagnosticsRecorder {
  private readonly rootDir: string;
  private readonly session: string;
  private readonly turn: string;
  private readonly registryKey: string;
  private readonly limits: TurnDiagnosticsLimits;
  private readonly now: () => number;
  private readonly startedAt: string;
  private readonly agent: string;
  private readonly secretValues: string[];
  private readonly counts: Record<string, number> = {};
  private readonly tail: EventSummary[] = [];
  private readonly stderrTail: string[] = [];
  private stderrPending = "";
  private stderrLineTruncated = false;
  private stderrPrivateKey = false;
  private stderrBytes = 0;
  private stderrLines = 0;
  private eventCount = 0;
  private nativeThreadHash: string | undefined;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private terminal: EventSummary | undefined;
  private finalFile: { exists: boolean | null; regular?: boolean; sizeBytes?: number; readError?: string } | undefined;
  private outcome: TurnDiagnosticOutcome | undefined;

  private constructor(options: StartOptions) {
    this.rootDir = resolve(options.rootDir);
    this.session = sessionHash(options.sessionName);
    this.turn = hash(`puppenclaw-turn-v1:${options.turnId}`);
    this.registryKey = `${this.rootDir}:${this.session}`;
    this.limits = limitOptions(options.limits);
    this.now = options.now ?? Date.now;
    this.startedAt = new Date(this.now()).toISOString();
    this.agent = ["codex", "claude", "fable"].includes(options.agent) ? options.agent : "other";
    this.secretValues = [...new Set(options.secretValues ?? [])]
      .filter(value => typeof value === "string" && value.length >= 6)
      .slice(0, 64).map(value => value.slice(0, MAX_PENDING_STDERR));
  }

  static async start(options: StartOptions): Promise<TurnDiagnosticsRecorder> {
    const recorder = new TurnDiagnosticsRecorder(options);
    await recorder.flush();
    const set = activeRecorders.get(recorder.registryKey) ?? new Set<TurnDiagnosticsRecorder>();
    set.add(recorder);
    activeRecorders.set(recorder.registryKey, set);
    const onError = options.onError;
    recorder.timer = setInterval(() => {
      void recorder.flush().catch((error: unknown) => {
        // Only an error code escapes the persistence boundary; filesystem
        // errors can contain private paths or user-controlled filenames.
        try { onError?.(new Error(`Turn diagnostics persistence failed (${errorCode(error)}).`)); }
        catch { /* Diagnostics must remain best-effort. */ }
      });
    }, Math.max(100, Math.min(options.flushIntervalMs ?? 5000, 30_000)));
    recorder.timer.unref();
    return recorder;
  }

  observeEvent(value: unknown): void {
    if (this.closed) return;
    const event = record(value);
    if (!event) return;
    const type = typeof event.type === "string" && EVENT_TYPES.has(event.type) ? event.type : "other";
    if (type === "thread.started" && typeof event.thread_id === "string") {
      this.nativeThreadHash = hash(event.thread_id);
    }
    const item = record(event.item) ?? record(event.output_item);
    const summary: EventSummary = { at: new Date(this.now()).toISOString(), type };
    if (typeof item?.type === "string" && ITEM_TYPES.has(item.type)) summary.itemType = item.type;
    const status = item?.status ?? event.status;
    if (typeof status === "string" && STATUSES.has(status)) summary.status = status;
    if (item?.type === "agent_message" && typeof item.text === "string") {
      summary.visibleTextCharacters = item.text.length;
    }
    const error = record(event.error) ?? record(item?.error);
    const category = diagnosticCategory(error?.message ?? event.message ?? item?.message);
    if (category) summary.errorCategory = category;
    this.eventCount = counter(this.eventCount + 1);
    this.counts[type] = counter((this.counts[type] ?? 0) + 1);
    this.tail.push(summary);
    if (this.tail.length > MAX_EVENT_TAIL) this.tail.shift();
    if (["turn.completed", "turn.failed", "turn.aborted", "turn.cancelled", "error", "response.failed", "response.incomplete", "result"].includes(type)) {
      this.terminal = summary;
    }
  }

  observeStderr(chunk: string): void {
    if (this.closed) return;
    this.stderrBytes = counter(this.stderrBytes + Buffer.byteLength(chunk));
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline < 0 ? chunk.length : newline;
      const remaining = MAX_PENDING_STDERR - this.stderrPending.length;
      this.stderrPending += chunk.slice(start, Math.min(end, start + remaining));
      if (end - start > remaining) this.stderrLineTruncated = true;
      if (newline < 0) break;
      this.completeStderrLine();
      start = newline + 1;
    }
  }

  private completeStderrLine(): void {
    const category = diagnosticCategory(this.stderrPending) ?? "content_withheld";
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u.test(this.stderrPending)) this.stderrPrivateKey = true;
    const diagnostic = this.stderrPrivateKey ? undefined : safeDiagnosticLine(this.stderrPending, this.secretValues);
    if (/-----END [A-Z0-9 ]*PRIVATE KEY-----/u.test(this.stderrPending)) this.stderrPrivateKey = false;
    this.stderrLines = counter(this.stderrLines + 1);
    this.stderrTail.push(`[${category}]${diagnostic ? ` ${diagnostic}` : ""}${this.stderrLineTruncated ? " [truncated]" : ""}`);
    if (this.stderrTail.length > MAX_STDERR_LINES) this.stderrTail.shift();
    this.stderrPending = "";
    this.stderrLineTruncated = false;
  }

  /** Inspect before the caller removes the final file; never read its content. */
  async recordFinalFile(path: string, readError?: unknown): Promise<void> {
    if (this.closed) return;
    let directory: number | undefined;
    let file: number | undefined;
    try {
      directory = pinDirectory(dirname(path));
      const stat = lstatSync(at(directory, basename(path)));
      this.finalFile = { exists: true, regular: stat.isFile(), sizeBytes: stat.size };
      if (!stat.isFile() || stat.nlink !== 1) {
        this.finalFile.readError = "UNSAFE_FILE";
      } else {
        file = openSync(at(directory, basename(path)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const actual = fstatSync(file);
        if (!actual.isFile() || actual.nlink !== 1) this.finalFile.readError = "UNSAFE_FILE";
        else this.finalFile.sizeBytes = actual.size;
      }
    } catch (error) {
      this.finalFile = { exists: errorCode(error) === "ENOENT" ? false : null, readError: errorCode(error) };
    } finally {
      if (file != null) closeSync(file);
      if (directory != null) closeSync(directory);
    }
    if (readError != null && this.finalFile) this.finalFile.readError = errorCode(readError);
  }

  async finish(outcome: TurnDiagnosticOutcome): Promise<void> {
    if (this.closed) return;
    if (this.stderrPending.length || this.stderrLineTruncated) this.completeStderrLine();
    this.outcome = {
      exitCode: Number.isSafeInteger(outcome.exitCode) ? outcome.exitCode : null,
      signal: outcome.signal == null ? null : SIGNALS.has(outcome.signal) ? outcome.signal : "OTHER",
      outcome: outcome.outcome,
      ...(outcome.reasonCode != null ? { reasonCode: REASONS.has(outcome.reasonCode) ? outcome.reasonCode : "other" } : {}),
    };
    try { await this.flush(); }
    finally { this.close(); }
  }

  async flush(): Promise<void> {
    if (this.closed) return;
    const snapshot = {
      version: 1,
      sessionHash: this.session,
      turnHash: this.turn,
      agent: this.agent,
      nativeThreadHash: this.nativeThreadHash ?? null,
      startedAt: this.startedAt,
      updatedAt: new Date(this.now()).toISOString(),
      state: this.outcome?.outcome ?? "running",
      eventCount: this.eventCount,
      eventCounts: this.counts,
      eventTail: [...this.tail],
      terminalEvent: this.terminal ?? null,
      finalFile: this.finalFile ?? null,
      process: this.outcome ?? null,
      stderr: {
        bytes: this.stderrBytes,
        lines: this.stderrLines,
        pendingBytes: Buffer.byteLength(this.stderrPending),
        policy: "Bounded redacted runtime diagnostics; prompt, reasoning, tool and request payloads are withheld.",
        tail: [...this.stderrTail],
      },
      truncated: false,
    };
    let text = `${JSON.stringify(snapshot)}\n`;
    while (Buffer.byteLength(text) > this.limits.maxTurnBytes) {
      snapshot.truncated = true;
      if (snapshot.eventTail.length) snapshot.eventTail.shift();
      else if (snapshot.stderr.tail.length) snapshot.stderr.tail.shift();
      else throw new Error("Turn diagnostics metadata exceeds byte limit.");
      text = `${JSON.stringify(snapshot)}\n`;
    }
    const root = pinRoot(this.rootDir, true);
    try {
      const directory = privateChild(root, this.session, true);
      try {
        const name = `${this.turn}.json`;
        try {
          const existing = lstatSync(at(directory, name));
          if (!existing.isFile() || existing.nlink !== 1) throw new Error("Refusing unsafe diagnostics record.");
        } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
        const temporary = `.${this.turn}.${randomUUID()}.tmp`;
        const file = openSync(at(directory, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          writeFileSync(file, text, "utf8");
          fsyncSync(file);
        } finally { closeSync(file); }
        try {
          renameSync(at(directory, temporary), at(directory, name));
          fsyncSync(directory);
        } finally {
          try { unlinkSync(at(directory, temporary)); }
          catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
        }
      } finally { closeSync(directory); }
    } finally { closeSync(root); }
    await pruneTurnDiagnostics(this.rootDir, { now: this.now(), limits: this.limits });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.stderrPending = "";
    this.secretValues.length = 0;
    const set = activeRecorders.get(this.registryKey);
    set?.delete(this);
    if (set?.size === 0) activeRecorders.delete(this.registryKey);
  }
}
