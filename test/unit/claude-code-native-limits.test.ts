import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { connect, createServer as createNetServer, type Server as NetServer } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AdvancedRuntime } from "../../src/advanced/runtime.js";
import { startParamsZod } from "../../src/shared/schema.js";
import { classifyProviderFailure } from "../../src/shared/provider-failures.js";
import type { SessionInfo } from "../../src/shared/types.js";
import { createTempDir } from "../helpers.js";

/**
 * Claude Code itself against the broker's native route, with a fake provider that answers with rate limits: the client
 * retries a 429 that the broker passes through, gives up at once on a Retry-After beyond 60 s, and stops after its
 * retries; in each case the broker's record (providerLimit) is what types the turn, because the client's own error
 * text names no provider failure. Opt-in, because this repository does not ship the client; the variable names its
 * binary:
 *   PUPPENCLAW_CLAUDE_CODE_BIN=/path/to/claude npx vitest run test/unit/claude-code-native-limits.test.ts
 */
const binary = process.env.PUPPENCLAW_CLAUDE_CODE_BIN;
const MODEL = "claude-fixture-model";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function listen(server: { listen(port: number, host: string, done: () => void): unknown; address(): unknown }): Promise<number> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as { port: number }).port;
}

function reply(res: ServerResponse, body: string): void {
  if (!JSON.parse(body || "{}").stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_fixture", type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: "Fixture reply." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 3 } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const events: [string, unknown][] = [
    ["message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fixture reply." } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }],
    ["message_stop", { type: "message_stop" }]
  ];
  res.end(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
}

/**
 * A fake Anthropic provider whose model calls get the given answers in turn (the last one repeats), a broker attempt
 * of a Claude Code controller on it, and a TCP port that forwards to the attempt's broker socket.
 */
async function brokerFor(answers: { status: number; retryAfter?: string }[]) {
  const calls: string[] = [];
  const provider = createServer((req, res) => {
    let body = ""; req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"type":"error","error":{"type":"not_found_error","message":"fixture"}}'); return; }
      const answer = answers[Math.min(calls.length, answers.length - 1)]!; calls.push(req.url);
      if (answer.status === 200) { reply(res, body); return; }
      res.writeHead(answer.status, { "content-type": "application/json", "request-id": "req_fixture", ...(answer.retryAfter ? { "retry-after": answer.retryAfter } : {}) });
      res.end('{"type":"error","error":{"type":"rate_limit_error","message":"fixture rate limit"}}');
    });
  });
  const providerPort = await listen(provider);
  cleanups.push(() => new Promise<void>((done) => { provider.closeAllConnections(); provider.close(() => done()); }));
  const root = await createTempDir("claude-code-native-limits-");
  const runtime = await AdvancedRuntime.open(join(root, "advanced")); cleanups.push(() => runtime.close());
  const modelProvider = { id: "anthropic-fixture", kind: "claude-code" as const, model: MODEL, baseUrl: `http://127.0.0.1:${providerPort}` };
  const params = startParamsZod.parse({ name: "controller", agent: "claude", directory: root, task: "Say hi.", interactionMode: "execute", permissionMode: "approve-all", statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt" }, modelProvider, orchestration: { version: 1, revision: 1, workers: [{ id: "refs", assignment: "Check sources", agent: "claude", modelProvider }] } });
  const session = { ...params, state: "idle", warnings: [], transcript: [], createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() } as SessionInfo;
  runtime.attach({ start: async () => ({ content: [], details: {} }), quiesce: async () => {}, getSession: () => session, contribution: () => {} });
  await runtime.begin(session, params, "approve-all");
  const socketPath = runtime.socket("controller")!;
  const forwarder: NetServer = createNetServer((client) => {
    const broker = connect(socketPath); client.pipe(broker).pipe(client);
    client.on("error", () => broker.destroy()); broker.on("error", () => client.destroy());
  });
  const forwarderPort = await listen(forwarder);
  cleanups.push(() => new Promise<void>((done) => forwarder.close(() => done())));
  return { root, runtime, calls, baseUrl: `http://127.0.0.1:${forwarderPort}/native` };
}

/** Runs `claude -p` with an isolated home and configuration, a fixture token and no other traffic. */
async function claude(root: string, baseUrl: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const home = join(root, "home"), config = join(root, "config"), work = join(root, "work");
  await Promise.all([home, config, work].map((path) => mkdir(path, { recursive: true })));
  const child = spawn(binary!, ["-p", "Say hi.", "--max-turns", "1", "--model", MODEL], {
    cwd: work, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: "fixture-token",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", ...env }
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

describe.skipIf(!binary)("Claude Code through the broker's native route meets provider rate limits", () => {
  it("retries one 429 that the broker passes through and completes", async () => {
    const { root, runtime, calls, baseUrl } = await brokerFor([{ status: 429, retryAfter: "1" }, { status: 200 }]);
    const result = await claude(root, baseUrl);
    expect(result).toMatchObject({ code: 0, stdout: "Fixture reply." });
    expect(calls).toHaveLength(2);
    expect(runtime.store.receipts("controller", "attempt").map((r) => [r.httpStatus, r.state])).toEqual([[429, "failed"], [200, "completed"]]);
    expect(runtime.providerLimit("controller")).toBeUndefined();
  }, 60_000);
  it("gives up at once on a Retry-After beyond 60 s, which the broker holds as a pause with that reset", async () => {
    const { root, runtime, calls, baseUrl } = await brokerFor([{ status: 429, retryAfter: "61" }]);
    const before = Date.now();
    const result = await claude(root, baseUrl);
    expect(result.code).not.toBe(0);
    expect(calls).toHaveLength(1);
    expect(result.stdout).toMatch(/\b429\b/u);
    expect(classifyProviderFailure({ agent: "claude", message: result.stdout })).toBeNull();
    const resumeAfter = Date.parse(runtime.providerLimit("controller")!.resumeAfter!);
    expect(resumeAfter).toBeGreaterThanOrEqual(before + 61_000);
    expect(resumeAfter).toBeLessThanOrEqual(Date.now() + 61_000);
  }, 60_000);
  it("waits out a Retry-After of 60 s, which the broker passes through", async () => {
    const { root, calls, baseUrl } = await brokerFor([{ status: 429, retryAfter: "60" }, { status: 200 }]);
    const result = await claude(root, baseUrl);
    expect(result).toMatchObject({ code: 0, stdout: "Fixture reply." });
    expect(calls).toHaveLength(2);
  }, 120_000);
  it("stops after its retries of a limit that outlasts them, which the broker holds as the newest answer", async () => {
    const { root, runtime, calls, baseUrl } = await brokerFor([{ status: 429, retryAfter: "1" }]);
    const result = await claude(root, baseUrl, { CLAUDE_CODE_MAX_RETRIES: "2" });
    expect(result.code).not.toBe(0);
    expect(calls).toHaveLength(3);
    expect(result.stdout).toMatch(/\b429\b/u);
    expect(classifyProviderFailure({ agent: "claude", message: result.stdout })).toBeNull();
    expect(runtime.providerLimit("controller")).toEqual({ resumeAfter: expect.any(String) });
  }, 60_000);
});
