import { createHash } from "node:crypto";
import {
  chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  purgeSessionDiagnostics,
  pruneTurnDiagnostics,
  TURN_DIAGNOSTICS_LIMITS,
  TurnDiagnosticsRecorder,
} from "../../src/manager/turn-diagnostics.js";

const roots: string[] = [];
const recorders: TurnDiagnosticsRecorder[] = [];
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "puppenclaw-turn-diagnostics-"));
  roots.push(root);
  return root;
}

function sessionKey(name: string): string {
  return createHash("sha256").update(`puppenclaw-turn-diagnostics-v1:${name}`).digest("hex");
}

async function start(rootDir: string, options: Partial<Parameters<typeof TurnDiagnosticsRecorder.start>[0]> = {}) {
  const recorder = await TurnDiagnosticsRecorder.start({
    rootDir, sessionName: "private-session", turnId: "statistics-" + "a".repeat(64), agent: "codex",
    ...options,
  });
  recorders.push(recorder);
  return recorder;
}

async function records(root: string): Promise<string[]> {
  const paths: string[] = [];
  for (const session of await readdir(join(root, "diagnostics"))) {
    const sessionPath = join(root, "diagnostics", session);
    if (!(await lstat(sessionPath)).isDirectory()) continue;
    for (const file of await readdir(sessionPath)) {
      if (file.endsWith(".json")) paths.push(join(sessionPath, file));
    }
  }
  return paths;
}

async function onlySnapshot(root: string) {
  const paths = await records(root);
  expect(paths).toHaveLength(1);
  return JSON.parse(await readFile(paths[0]!, "utf8"));
}

afterEach(async () => {
  for (const recorder of recorders.splice(0)) recorder.close();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("private bounded turn diagnostics", () => {
  it("persists process outcome, terminal metadata and final-file size without transcript content", async () => {
    const root = await directory();
    const recorder = await start(root);
    recorder.observeEvent({ type: "thread.started", thread_id: "SECRET-THREAD-NAME" });
    recorder.observeEvent({ type: "item.completed", item: { type: "agent_message", text: "PRIVATE ASSISTANT MESSAGE" } });
    recorder.observeEvent({ type: "turn.failed", error: { message: "context length exceeded; prompt=SECRET-PROMPT" } });
    const final = join(root, "final.txt");
    await writeFile(final, "PRIVATE FINAL ANSWER");
    await recorder.recordFinalFile(final);
    await recorder.finish({ exitCode: 0, signal: null, outcome: "failed", reasonCode: "NO_FINAL_MESSAGE" });
    const snapshot = await onlySnapshot(root);
    expect(snapshot).toMatchObject({
      state: "failed", agent: "codex", eventCount: 3,
      eventCounts: { "thread.started": 1, "item.completed": 1, "turn.failed": 1 },
      terminalEvent: { type: "turn.failed", errorCategory: "context_limit" },
      process: { exitCode: 0, signal: null, outcome: "failed", reasonCode: "NO_FINAL_MESSAGE" },
      finalFile: { exists: true, regular: true, sizeBytes: 20 },
    });
    expect(snapshot.eventTail[1].visibleTextCharacters).toBe(25);
    expect(JSON.stringify(snapshot)).not.toMatch(/SECRET|PRIVATE|private-session|statistics-/u);
  });

  it("retains actual signal instead of inventing an exit code for a killed process", async () => {
    const root = await directory();
    const recorder = await start(root);
    await recorder.recordFinalFile(join(root, "absent.txt"));
    await recorder.finish({ exitCode: null, signal: "SIGKILL", outcome: "failed", reasonCode: "signal" });
    expect(await onlySnapshot(root)).toMatchObject({
      process: { exitCode: null, signal: "SIGKILL" },
      finalFile: { exists: false, readError: "ENOENT" },
    });
  });

  it("withholds prompts, reasoning, tool payloads, environment and chunk-split secrets from stderr", async () => {
    const root = await directory();
    const recorder = await start(root);
    recorder.observeEvent({ type: "SECRET-TYPE", item: { type: "SECRET-ITEM", status: "SECRET-STATUS", arguments: "SECRET-TOOL", text: "SECRET-REASONING" }, env: { token: "SECRET-ENV" } });
    recorder.observeEvent({ type: "item.completed", item: { type: "reasoning", text: "SECRET-REASONING" } });
    recorder.observeStderr("Authorization: Bea");
    recorder.observeStderr("rer SECRET-BEARER\ninvalid api key: sk-proj-SECRET-KEY\n");
    recorder.observeStderr("-----BEGIN RSA PRIVATE KEY-----\nSECRET-PRIVATE-KEY\n-----END RSA PRIVATE KEY-----\n");
    recorder.observeStderr("request={\"prompt\":\"SECRET-PROMPT\",\"tools\":\"SECRET-TOOLS\"}\n");
    recorder.observeStderr("MY_API_TOKEN=SECRET-ENV\nHTTP 429: rate limit exceeded\n");
    recorder.observeStderr("HTTP 503 failed response: " + "SECRET-BODY".repeat(10000));
    await recorder.finish({ exitCode: 1, signal: null, outcome: "failed", reasonCode: "SECRET-REASON" });
    const snapshot = await onlySnapshot(root);
    const text = JSON.stringify(snapshot);
    expect(text).not.toMatch(/SECRET|PRIVATE KEY|Bearer|sk-proj|MY_API_TOKEN/u);
    expect(snapshot.stderr.bytes).toBeGreaterThan(100000);
    expect(snapshot.stderr.tail).toContain("[authentication]");
    expect(snapshot.stderr.tail).toContain("[rate_limit]");
    expect(snapshot.stderr.tail).toContain("[upstream_server_error] [truncated]");
    expect(snapshot.eventCounts.other).toBe(1);
    expect(snapshot.process.reasonCode).toBe("other");
  });

  it("records collab_tool_call items and never counts OCSL wrapper metadata as an event", async () => {
    const root = await directory();
    const recorder = await start(root);
    recorder.observeEvent({ type: "item.completed", item: { id: "c", type: "collab_tool_call", tool: "spawn_agent", status: "completed" } });
    recorder.observeEvent({ type: "ocsl.model_usage", version: 1, threads: [] });
    await recorder.finish({ exitCode: 0, signal: null, outcome: "completed" });
    const snapshot = await onlySnapshot(root);
    expect(snapshot.eventCount).toBe(1);
    expect(snapshot.eventCounts).toEqual({ "item.completed": 1 });
    expect(snapshot.eventTail).toMatchObject([{ type: "item.completed", itemType: "collab_tool_call", status: "completed" }]);
  });

  it("keeps readable novel runtime errors while suppressing inline and multiline payload dumps", async () => {
    const root = await directory();
    const recorder = await start(root);
    recorder.observeStderr("2026-09-15T11:09:28Z ERROR codex_core::stream: unexpected end of stream before final message\n");
    recorder.observeStderr("Warning: no last agent message; wrote empty content\n");
    recorder.observeStderr("Failed to write last message file /tmp/last-message.txt: Permission denied\n");
    recorder.observeStderr("error: authentication failed; api_key=SECRET-KEY cookie=SECRET-COOKIE\n");
    recorder.observeStderr("ERROR provider: HTTP 400; request={\"messages\":[\"SECRET-MANUSCRIPT\"]}\n");
    recorder.observeStderr("ERROR provider: malformed response: {\"content\":\"SECRET-REASONING\"}\n");
    recorder.observeStderr("ERROR provider: payload {\"tool\":\"SECRET-TOOL\"}\n");
    recorder.observeStderr("ERROR provider: raw request follows\nSECRET-RAW-REQUEST\n");
    recorder.observeStderr("ERROR provider: prompt was SECRET-PROMPT\n");
    recorder.observeStderr("ERROR env: environment variables SECRET-ENV\n");
    recorder.observeStderr("ERROR connection https://user:SECRET-PASSWORD@server.invalid/path?unknown=SECRET-QUERY\n");
    await recorder.finish({ exitCode: 0, signal: null, outcome: "failed" });
    const text = JSON.stringify(await onlySnapshot(root));
    expect(text).toContain("unexpected end of stream before final message");
    expect(text).toContain("no last agent message; wrote empty content");
    expect(text).toContain("Failed to write last message file /tmp/last-message.txt: Permission denied");
    expect(text).toContain("HTTP 400");
    expect(text).toContain("[payload withheld]");
    expect(text).not.toContain("SECRET");
  });

  it("redacts explicitly supplied secret values without retaining an environment record", async () => {
    const root = await directory();
    const recorder = await start(root, { secretValues: ["sensitiveCredential123", "short"] });
    recorder.observeStderr("ERROR authentication rejected sensitiveCredential123\n");
    recorder.observeStderr("Failed to connect using sensitiveCredential123\n");
    await recorder.finish({ exitCode: 1, signal: null, outcome: "failed" });
    const text = JSON.stringify(await onlySnapshot(root));
    expect(text).not.toContain("sensitiveCredential123");
    expect(text).toContain("authentication rejected [redacted]");
    expect(text).toContain("Failed to connect using [redacted]");
  });

  it("preserves Rust module separators while withholding actual colon and equals payload fields", async () => {
    const root = await directory();
    const recorder = await start(root);
    recorder.observeStderr("2026-09-15T11:09:28Z ERROR codex_core::tools::handlers::shell: timed out waiting for process completion\n");
    recorder.observeStderr("ERROR codex_core::tools::parallel: task join failed before final response\n");
    for (const field of ["request:", "request=", "tool:", "tool="]) {
      recorder.observeStderr(`ERROR codex_core::tools::parallel: failed to process ${field}SECRET-PAYLOAD\n`);
    }
    await recorder.finish({ exitCode: 1, signal: null, outcome: "failed" });
    const text = JSON.stringify(await onlySnapshot(root));
    expect(text).toContain("codex_core::tools::handlers::shell: timed out waiting for process completion");
    expect(text).toContain("codex_core::tools::parallel: task join failed before final response");
    expect(text).toContain("codex_core::tools::parallel: failed to process [payload withheld]");
    expect(text).not.toContain("SECRET-PAYLOAD");
  });

  it("records only allowlisted visible message phases without retaining prose or private phases", async () => {
    const root = await directory();
    const recorder = await start(root);
    for (const phase of ["commentary", "final_answer", "analysis", "reasoning", "SECRET-ARBITRARY-PHASE"]) {
      recorder.observeEvent({ type: "item.completed", item: { type: "agent_message", phase, text: "SECRET-PROSE" } });
    }
    await recorder.finish({ exitCode: 0, signal: null, outcome: "completed" });
    const snapshot = await onlySnapshot(root);
    expect(snapshot.eventTail.map((event: { phase?: string }) => event.phase)).toEqual([
      "commentary", "final_answer", undefined, undefined, undefined,
    ]);
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("SECRET");
    expect(JSON.stringify(snapshot.eventTail)).not.toMatch(/analysis|reasoning/u);
  });

  it("periodically persists in-flight evidence without a terminal callback", async () => {
    vi.useFakeTimers();
    const root = await directory();
    const recorder = await start(root, { flushIntervalMs: 100 });
    recorder.observeEvent({ type: "item.completed", item: { type: "mcp_tool_call", arguments: "PRIVATE" } });
    recorder.observeStderr("connection refused\n");
    await vi.advanceTimersByTimeAsync(150);
    recorder.close(); // Simulates losing the native terminal event.
    expect(await onlySnapshot(root)).toMatchObject({
      state: "running", eventCount: 1, process: null,
      stderr: { tail: ["[connection_refused]"] },
    });
  });

  it("keeps event keys and tails bounded and enforces the per-turn byte ceiling", async () => {
    const root = await directory();
    const recorder = await start(root, { limits: { maxTurnBytes: 4096 } });
    for (let i = 0; i < 10000; i++) {
      recorder.observeEvent({ type: `secret-event-${i}`, item: { type: "reasoning", text: "PRIVATE".repeat(100) } });
      recorder.observeStderr("rate limit exceeded\n");
    }
    await recorder.finish({ exitCode: 0, signal: null, outcome: "completed" });
    const snapshot = await onlySnapshot(root);
    expect(snapshot.eventCount).toBe(10000);
    expect(Object.keys(snapshot.eventCounts)).toEqual(["other"]);
    expect(snapshot.eventTail.length).toBeLessThanOrEqual(128);
    expect(snapshot.stderr.tail.length).toBeLessThanOrEqual(64);
    expect(snapshot.stderr.lines).toBe(10000);
    expect(snapshot.truncated).toBe(true);
    expect((await lstat((await records(root))[0]!)).size).toBeLessThanOrEqual(4096);
  });

  it("uses 0700 directories, 0600 files and hashes both unsafe session and turn identifiers", async () => {
    const root = await directory();
    const recorder = await start(root, { sessionName: "../../private/name", turnId: "../../final\0secret" });
    await recorder.finish({ exitCode: 0, signal: null, outcome: "completed" });
    const diagnostics = join(root, "diagnostics");
    const sessions = await readdir(diagnostics);
    expect(sessions[0]).toMatch(/^[a-f0-9]{64}$/u);
    const file = (await records(root))[0]!;
    expect((await lstat(diagnostics)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(diagnostics, sessions[0]!))).mode & 0o777).toBe(0o700);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect(file).toMatch(/[a-f0-9]{64}\.json$/u);
  });

  it("refuses symlinked root, ancestor, session and record paths without touching their targets", async () => {
    const root = await directory();
    const outside = await directory();
    await writeFile(join(outside, "sentinel"), "DO NOT CHANGE");
    await symlink(outside, join(root, "diagnostics"));
    await expect(start(root)).rejects.toThrow();
    expect(await readdir(outside)).toEqual(["sentinel"]);
    await rm(join(root, "diagnostics"));
    await mkdir(join(root, "diagnostics"));
    await symlink(outside, join(root, "diagnostics", sessionKey("private-session")));
    await expect(start(root)).rejects.toThrow();
    await expect(purgeSessionDiagnostics(root, "private-session")).rejects.toThrow();
    await rm(join(root, "diagnostics", sessionKey("private-session")));
    const recorder = await start(root);
    const file = (await records(root))[0]!;
    await rm(file);
    await symlink(join(outside, "sentinel"), file);
    await expect(recorder.flush()).rejects.toThrow(/unsafe/iu);
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("DO NOT CHANGE");
    await symlink(root, join(outside, "linked-root"));
    await expect(start(join(outside, "linked-root"))).rejects.toThrow();
  });

  it("refuses hard-linked record replacement and final-file symlinks", async () => {
    const root = await directory();
    const recorder = await start(root);
    const file = (await records(root))[0]!;
    const sentinel = join(root, "sentinel");
    await writeFile(sentinel, "SECRET");
    await rm(file);
    await link(sentinel, file);
    await expect(recorder.flush()).rejects.toThrow(/unsafe/iu);
    expect(await readFile(sentinel, "utf8")).toBe("SECRET");
    await rm(file);
    await symlink(sentinel, join(root, "final-link"));
    await recorder.recordFinalFile(join(root, "final-link"));
    await recorder.finish({ exitCode: 0, signal: null, outcome: "failed" });
    expect(await onlySnapshot(root)).toMatchObject({ finalFile: { exists: true, regular: false, readError: "UNSAFE_FILE" } });
  });

  it("restores private directory and record permissions on subsequent writes", async () => {
    const root = await directory();
    const recorder = await start(root);
    const file = (await records(root))[0]!;
    await chmod(join(root, "diagnostics"), 0o755);
    await chmod(join(root, "diagnostics", sessionKey("private-session")), 0o777);
    await chmod(file, 0o644);
    await recorder.flush();
    expect((await lstat(join(root, "diagnostics"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "diagnostics", sessionKey("private-session")))).mode & 0o777).toBe(0o700);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
  });

  it("retains at most ten turns per session", async () => {
    const root = await directory();
    for (let i = 0; i < 13; i++) {
      const recorder = await start(root, { turnId: `turn-${i}` });
      await recorder.finish({ exitCode: 0, signal: null, outcome: "completed" });
    }
    expect((await records(root)).length).toBe(10);
    expect(TURN_DIAGNOSTICS_LIMITS.maxTurnBytes).toBe(1024 * 1024);
    expect(TURN_DIAGNOSTICS_LIMITS.maxGlobalBytes).toBe(128 * 1024 * 1024);
  });

  it("prunes expired, oversized and globally over-budget records without reading their bodies", async () => {
    const root = await directory();
    for (let i = 0; i < 5; i++) {
      const recorder = await start(root, { sessionName: `session-${i}` });
      await recorder.finish({ exitCode: 0, signal: null, outcome: "completed" });
    }
    const files = await records(root);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(files[0]!, old, old);
    await writeFile(files[1]!, "X".repeat(1024 * 1024 + 1));
    await pruneTurnDiagnostics(root, { limits: { maxGlobalBytes: 2000 } });
    const remaining = await records(root);
    expect(remaining).not.toContain(files[0]);
    expect(remaining).not.toContain(files[1]);
    const sizes = await Promise.all(remaining.map(async path => (await lstat(path)).size));
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2000);
    expect(remaining.length).toBeGreaterThan(0);
  });

  it("purges only the requested session and fences active periodic writers", async () => {
    vi.useFakeTimers();
    const root = await directory();
    const recorder = await start(root, { flushIntervalMs: 100 });
    const other = await start(root, { sessionName: "other" });
    await other.finish({ exitCode: 0, signal: null, outcome: "completed" });
    await purgeSessionDiagnostics(root, "private-session");
    recorder.observeEvent({ type: "turn.completed" });
    await recorder.flush();
    await recorder.finish({ exitCode: 0, signal: null, outcome: "completed" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await readdir(join(root, "diagnostics"))).toEqual([sessionKey("other")]);
    await purgeSessionDiagnostics(root, "private-session");
    await purgeSessionDiagnostics(root, "other");
    expect(await records(root)).toEqual([]);
  });

  it("reports periodic write failures by redacted code without throwing from the timer", async () => {
    vi.useFakeTimers();
    const root = await directory();
    const outside = await directory();
    const onError = vi.fn();
    await start(root, { flushIntervalMs: 100, onError });
    await rm(join(root, "diagnostics"), { recursive: true });
    await symlink(outside, join(root, "diagnostics"));
    await vi.advanceTimersByTimeAsync(200);
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0]![0].message).toMatch(/^Turn diagnostics persistence failed \(E[A-Z]+\)\.$/u);
    expect(await readdir(outside)).toEqual([]);
  });
});
