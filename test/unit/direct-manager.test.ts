import { describe, expect, it } from "vitest";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { PuppenclawError } from "../../src/shared/errors.js";
import { SessionStore } from "../../src/shared/store.js";
import {
  fingerprintSendRequest
} from "../../src/shared/turn-idempotency.js";
import { UsageLedgerStore } from "../../src/shared/usage-ledger.js";
import type { SessionInfo } from "../../src/shared/types.js";
import { createStoreAndRouter, createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

async function resolveWhitespaceFakeAcpxCommand(workspaceDir: string): Promise<string> {
  const fakeAcpxPath = join(workspaceDir, "fake-whitespace-acpx.mjs");
  await writeFile(
    fakeAcpxPath,
    `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const cwdIndex = args.indexOf("--cwd");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
const commandIndex = args.findIndex((arg) => ["status", "sessions", "prompt"].includes(arg));
const command = commandIndex >= 0 ? args.slice(commandIndex) : [];
const stateDir = join(cwd, ".fake-acpx-state");
mkdirSync(stateDir, { recursive: true });

function emit(value) {
  writeSync(1, JSON.stringify(value) + "\\n");
}

function sessionFile(name) {
  return join(stateDir, \`\${basename(name)}.session\`);
}

if (command[0] === "status" && command[1] === "--session" && command[2]) {
  if (!existsSync(sessionFile(command[2]))) {
    emit({ action: "status_snapshot", status: "no-session", summary: "no active session" });
    process.exit(0);
  }
  emit({ status: "alive", summary: "ready" });
  process.exit(0);
}

if (command[0] === "sessions" && command[1] === "new") {
  const nameIndex = command.indexOf("--name");
  const name = nameIndex >= 0 ? command[nameIndex + 1] : "demo";
  writeFileSync(sessionFile(name), "alive\\n", "utf8");
  emit({ status: "alive" });
  process.exit(0);
}

if (command[0] === "sessions" && command[1] === "show" && command[2]) {
  emit({ messages: [] });
  process.exit(0);
}

if (command[0] === "sessions" && command[1] === "history") {
  emit({ entries: [] });
  process.exit(0);
}

if (command[0] === "prompt" && command[1] === "--session" && command[2]) {
  readFileSync(0, "utf8");
  for (const text of ["Alpha", " beta", " ", "gamma", "\\nNext", " line"]) {
    emit({ type: "agent_message_chunk", content: { type: "text", text } });
  }
  emit({ type: "done" });
  process.exit(0);
}

console.error(\`unsupported fake acpx command: \${command.join(" ")}\`);
process.exit(1);
`,
    "utf8"
  );
  return `node "${fakeAcpxPath.replaceAll('"', '\\"')}"`;
}

async function resolveFakeCodexJsonCommand(workspaceDir: string): Promise<string> {
  const fakeCodexPath = join(workspaceDir, "fake-codex-json.mjs");
  const releasePath = join(workspaceDir, ".fake-codex-json-release");
  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
const cwdIndex = args.indexOf("--cd");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
const releasePath = ${JSON.stringify(releasePath)};
const counterPath = join(cwd, ".fake-codex-json-count");
const invocation = existsSync(counterPath)
  ? Number.parseInt(readFileSync(counterPath, "utf8"), 10) || 0
  : 0;
writeFileSync(counterPath, String(invocation + 1), "utf8");

let promptText = "";
for await (const chunk of process.stdin) {
  promptText += chunk;
}
const longRunningTurn = invocation > 0;

function emit(value) {
  writeSync(1, JSON.stringify(value) + "\\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

emit({ type: "turn_started" });
writeSync(1, "LIVE RAW PROGRESS token=malformed-stream-secret\\n");
emit({
  type: "response_item",
  item: {
    type: "function_call",
    name: "exec_command",
    arguments: "{\\"cmd\\":\\"date\\",\\"authorization\\":\\"Bearer should-not-leak\\"}"
  }
});
emit({
  type: "response_item",
  item: {
    type: "message",
    tool_calls: [
      {
        type: "function",
        function: {
          name: "mcp__paper_search_mcp__search_pubmed",
          arguments: "{\\"query\\":\\"RSV\\"}"
        }
      }
    ]
  }
});
await sleep(longRunningTurn ? 1500 : 20);
emit({
  type: "response_item",
  item: {
    type: "function_call_output",
    output: "command output line\\nsecond line\\ntoken=tool-output-secret"
  }
});
await sleep(80);
emit({
  type: "response_item",
  item: {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Final streamed answer." }]
  }
});
if (longRunningTurn) {
  const releaseDeadline = Date.now() + 10_000;
  while (!existsSync(releasePath) && Date.now() < releaseDeadline) {
    await sleep(10);
  }
  if (!existsSync(releasePath)) {
    throw new Error("test did not release the fake Codex turn");
  }
}
if (outputPath != null) {
  writeFileSync(outputPath, "Final file answer.", "utf8");
}
`,
    "utf8"
  );
  return `node "${fakeCodexPath.replaceAll('"', '\\"')}"`;
}

async function resolveFakeCodexFailureCommand(workspaceDir: string): Promise<string> {
  const fakeCodexPath = join(workspaceDir, "fake-codex-failure.mjs");
  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
const cwdIndex = args.indexOf("--cd");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
const counterPath = join(cwd, ".fake-codex-failure-count");
const invocation = existsSync(counterPath)
  ? Number.parseInt(readFileSync(counterPath, "utf8"), 10) || 0
  : 0;
writeFileSync(counterPath, String(invocation + 1), "utf8");

for await (const _chunk of process.stdin) {}

function emit(value) {
  writeSync(1, JSON.stringify(value) + "\\n");
}

if (invocation === 0) {
  emit({
    type: "response_item",
    item: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Initial successful report." }]
    }
  });
  if (outputPath != null) {
    writeFileSync(outputPath, "Initial successful report.", "utf8");
  }
  process.exit(0);
}

emit({
  type: "response_item",
  item: {
    type: "function_call",
    name: "exec_command",
    arguments: "{\\"cmd\\":\\"build report\\",\\"authorization\\":\\"Bearer failure-tool-secret\\"}"
  }
});
writeSync(1, "MALFORMED FAILURE token=failure-stream-secret\\n");
writeSync(2, "stream disconnected before completion: {\\"error\\":\\"The operation was aborted due to timeout\\"}\\n");
process.exit(1);
`,
    "utf8"
  );
  return `node "${fakeCodexPath.replaceAll('"', '\\"')}"`;
}

async function resolveFakeCodexPermissionCommand(workspaceDir: string): Promise<string> {
  const fakeCodexPath = join(workspaceDir, "fake-codex-permissions.mjs");
  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
const cwdIndex = args.indexOf("--cd");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
const counterPath = join(cwd, ".fake-codex-permission-count");
const invocation = existsSync(counterPath)
  ? Number.parseInt(readFileSync(counterPath, "utf8"), 10) || 0
  : 0;
writeFileSync(counterPath, String(invocation + 1), "utf8");

const promptText = readFileSync(0, "utf8");
writeFileSync(join(cwd, \`.fake-codex-permission-args-\${invocation}.json\`), JSON.stringify(args), "utf8");
writeFileSync(join(cwd, \`.fake-codex-permission-prompt-\${invocation}.txt\`), promptText, "utf8");
writeFileSync(join(cwd, \`.fake-codex-permission-env-\${invocation}.json\`), JSON.stringify({
  direct: process.env.PUPPENCLAW_DIRECT_CODEX_AGENT_COMMAND ?? null,
  persistent: process.env.PUPPENCLAW_REAL_CODEX_AGENT_COMMAND ?? null,
  turnPolicy: process.env.PUPPENCLAW_CODEX_TURN_POLICY ?? null,
  modelProviderId: process.env.PUPPENCLAW_MODEL_PROVIDER_ID ?? null,
  modelProviderModel: process.env.PUPPENCLAW_MODEL_PROVIDER_MODEL ?? null,
  modelProviderKind: process.env.PUPPENCLAW_MODEL_PROVIDER_KIND ?? null,
  modelProviderBaseUrl: process.env.PUPPENCLAW_MODEL_PROVIDER_BASE_URL ?? null
}), "utf8");

const answer = \`Captured permission turn \${invocation}.\`;
writeSync(1, JSON.stringify({
  type: "response_item",
  item: {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: answer }]
  }
}) + "\\n");
if (outputPath != null) {
  writeFileSync(outputPath, answer, "utf8");
}
`,
    "utf8"
  );
  return `node "${fakeCodexPath.replaceAll('"', '\\"')}"`;
}

async function resolveFakeCodexEmptyFinalCommand(workspaceDir: string): Promise<string> {
  const fakeCodexPath = join(workspaceDir, "fake-codex-empty-final.mjs");
  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
const cwdIndex = args.indexOf("--cd");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
const counterPath = join(cwd, ".fake-codex-empty-final-count");
const invocation = existsSync(counterPath)
  ? Number.parseInt(readFileSync(counterPath, "utf8"), 10) || 0
  : 0;
writeFileSync(counterPath, String(invocation + 1), "utf8");

readFileSync(0, "utf8");

function emit(value) {
  writeSync(1, JSON.stringify(value) + "\\n");
}

emit({ type: "turn_started" });
if (invocation === 0) {
  emit({
    type: "response_item",
    item: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "First answer." }]
    }
  });
  if (outputPath != null) {
    writeFileSync(outputPath, "First answer.", "utf8");
  }
}
`,
    "utf8"
  );
  return `node "${fakeCodexPath.replaceAll('"', '\\"')}"`;
}

async function resolveEmptyTurnFakeAcpxCommand(workspaceDir: string): Promise<string> {
  const fakeAcpxPath = join(workspaceDir, "fake-empty-turn-acpx.mjs");
  await writeFile(
    fakeAcpxPath,
    `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const cwdIndex = args.indexOf("--cwd");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
const commandIndex = args.findIndex((arg) => ["status", "sessions", "prompt"].includes(arg));
const command = commandIndex >= 0 ? args.slice(commandIndex) : [];
const stateDir = join(cwd, ".fake-acpx-state");
mkdirSync(stateDir, { recursive: true });

function emit(value) {
  writeSync(1, JSON.stringify(value) + "\\n");
}

function sessionFile(name) {
  return join(stateDir, \`\${basename(name)}.session\`);
}

if (command[0] === "status" && command[1] === "--session" && command[2]) {
  if (!existsSync(sessionFile(command[2]))) {
    emit({ action: "status_snapshot", status: "no-session", summary: "no active session" });
    process.exit(0);
  }
  emit({ status: "alive", summary: "ready" });
  process.exit(0);
}

if (command[0] === "sessions" && command[1] === "new") {
  const nameIndex = command.indexOf("--name");
  const name = nameIndex >= 0 ? command[nameIndex + 1] : "demo";
  writeFileSync(sessionFile(name), "alive\\n", "utf8");
  emit({ status: "alive" });
  process.exit(0);
}

if (command[0] === "sessions" && command[1] === "show" && command[2]) {
  emit({ messages: [] });
  process.exit(0);
}

if (command[0] === "sessions" && command[1] === "history") {
  emit({ entries: [] });
  process.exit(0);
}

if (command[0] === "prompt" && command[1] === "--session" && command[2]) {
  readFileSync(0, "utf8");
  emit({ type: "done" });
  process.exit(0);
}

console.error(\`unsupported fake acpx command: \${command.join(" ")}\`);
process.exit(1);
`,
    "utf8"
  );
  return `node "${fakeAcpxPath.replaceAll('"', '\\"')}"`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AcpxSessionManager", () => {
  it("starts a session, streams output, and records status", async () => {
    const workspaceDir = await createTempDir("puppenclaw-local-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const chunks: string[] = [];
    outputRouter.attach("demo", async (event) => {
      if (event.kind === "chunk") {
        chunks.push(event.text);
      }
    });

    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const result = await manager.start({
      agent: "codex",
      name: "demo",
      directory: workspaceDir,
      task: "Implement the server side.",
      contextFiles: []
    });
    const startDetails = result.details as {
      session: SessionInfo;
      output: string;
      outputRole: "assistant" | "status";
    };
    expect(startDetails.session.name).toBe("demo");
    expect(startDetails.output).toContain("Handled:");
    expect(startDetails.outputRole).toBe("assistant");
    expect(chunks.join("")).toContain("Handled:");

    const status = await manager.status({ name: "demo" });
    const statusDetails = status.details as {
      session: SessionInfo;
      runtime: {
        exists: boolean;
      };
    };
    expect(statusDetails.session.name).toBe("demo");
    expect(statusDetails.runtime.exists).toBe(true);
  });

  it("applies a send permission override for one turn without persisting it", async () => {
    const workspaceDir = await createTempDir("puppenclaw-turn-permission-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand, permissionMode: "approve-all" }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const started = await manager.start({
      agent: "claude",
      name: "turn-permission-demo",
      directory: workspaceDir,
      task: "REPORT_PERMISSION_MODE",
      permissionMode: "approve-reads",
      contextFiles: []
    });
    expect((started.details as { output: string }).output).toBe(
      "Permission mode: approve-reads"
    );
    expect((started.details as { session: SessionInfo }).session.permissionMode).toBe(
      "approve-all"
    );

    const approved = await manager.send({
      name: "turn-permission-demo",
      message: "REPORT_PERMISSION_MODE",
      permissionMode: "approve-all",
      contextFiles: []
    });
    const approvedDetails = approved.details as { session: SessionInfo; output: string };
    expect(approvedDetails.output).toBe("Permission mode: approve-all");
    expect(approvedDetails.session.permissionMode).toBe("approve-all");

    const denied = await manager.send({
      name: "turn-permission-demo",
      message: "REPORT_PERMISSION_MODE",
      permissionMode: "deny-all",
      contextFiles: []
    });
    const deniedDetails = denied.details as { session: SessionInfo; output: string };
    expect(deniedDetails.output).toBe("Permission mode: deny-all");
    expect(deniedDetails.session.permissionMode).toBe("approve-all");

    const following = await manager.send({
      name: "turn-permission-demo",
      message: "REPORT_PERMISSION_MODE",
      contextFiles: []
    });
    const followingDetails = following.details as { session: SessionInfo; output: string };
    expect(followingDetails.output).toBe("Permission mode: approve-all");
    expect(followingDetails.session.permissionMode).toBe("approve-all");
  });

  it("applies start-time elevation for one turn without persisting it", async () => {
    const workspaceDir = await createTempDir("puppenclaw-start-permission-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand: await resolveFakeAcpxCommand(),
        permissionMode: "approve-reads"
      }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store,
      outputRouter
    });

    const started = await manager.start({
      agent: "claude",
      name: "elevated-start",
      directory: workspaceDir,
      task: "REPORT_PERMISSION_MODE",
      permissionMode: "approve-all",
      contextFiles: []
    });
    const startedDetails = started.details as { session: SessionInfo; output: string };
    expect(startedDetails.output).toBe("Permission mode: approve-all");
    expect(startedDetails.session.permissionMode).toBe("approve-reads");

    const following = await manager.send({
      name: "elevated-start",
      message: "REPORT_PERMISSION_MODE",
      contextFiles: []
    });
    expect((following.details as { session: SessionInfo; output: string })).toMatchObject({
      output: "Permission mode: approve-reads",
      session: { permissionMode: "approve-reads" }
    });
  });

  it("never elevates a deny-all baseline", async () => {
    const workspaceDir = await createTempDir("puppenclaw-deny-all-start-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand: await resolveFakeAcpxCommand(),
        permissionMode: "deny-all"
      }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store,
      outputRouter
    });

    const started = await manager.start({
      agent: "claude",
      name: "deny-all-start",
      directory: workspaceDir,
      task: "REPORT_PERMISSION_MODE",
      permissionMode: "approve-all",
      contextFiles: []
    });
    expect((started.details as { session: SessionInfo; output: string })).toMatchObject({
      output: "Permission mode: deny-all",
      session: { permissionMode: "deny-all" }
    });
    const attemptedElevation = await manager.send({
      name: "deny-all-start",
      message: "REPORT_PERMISSION_MODE",
      permissionMode: "approve-all",
      contextFiles: []
    });
    expect((attemptedElevation.details as { session: SessionInfo; output: string })).toMatchObject({
      output: "Permission mode: deny-all",
      session: { permissionMode: "deny-all" }
    });
  });

  it("allows a lower permission mode for one turn without lowering the baseline", async () => {
    const workspaceDir = await createTempDir("puppenclaw-lower-turn-permission-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand, permissionMode: "approve-all" }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const started = await manager.start({
      agent: "claude",
      name: "lower-turn-permission-demo",
      directory: workspaceDir,
      task: "REPORT_PERMISSION_MODE",
      contextFiles: []
    });
    expect((started.details as { output: string }).output).toBe(
      "Permission mode: approve-all"
    );

    const lowered = await manager.send({
      name: "lower-turn-permission-demo",
      message: "REPORT_PERMISSION_MODE",
      permissionMode: "approve-reads",
      contextFiles: []
    });
    const loweredDetails = lowered.details as { session: SessionInfo; output: string };
    expect(loweredDetails.output).toBe("Permission mode: approve-reads");
    expect(loweredDetails.session.permissionMode).toBe("approve-all");

    const following = await manager.send({
      name: "lower-turn-permission-demo",
      message: "REPORT_PERMISSION_MODE",
      contextFiles: []
    });
    const followingDetails = following.details as { session: SessionInfo; output: string };
    expect(followingDetails.output).toBe("Permission mode: approve-all");
    expect(followingDetails.session.permissionMode).toBe("approve-all");
  });

  it("maps one-shot Codex permissions to process arguments per turn", async () => {
    const workspaceDir = await createTempDir("puppenclaw-codex-permissions-");
    const codexCommand = await resolveFakeCodexPermissionCommand(workspaceDir);
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        agentCommands: { codex: codexCommand }
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });
    const modelProvider = {
      id: "fake-openai-compatible",
      kind: "codex-openai-compatible" as const,
      model: "fake-model",
      baseUrl: "http://example.invalid/v1",
      authTokenEnv: "FAKE_CODEX_TOKEN",
      wireApi: "responses" as const
    };

    await manager.start({
      agent: "codex",
      name: "codex-permission-demo",
      directory: workspaceDir,
      task: "Start read-only.",
      interactionMode: "plan",
      contextFiles: [],
      modelProvider
    });
    const readOnlyArgs = JSON.parse(
      await readFile(join(workspaceDir, ".fake-codex-permission-args-0.json"), "utf8")
    ) as string[];
    const readOnlySandboxIndex = readOnlyArgs.indexOf("--sandbox");
    expect(readOnlyArgs).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(readOnlyArgs.slice(readOnlySandboxIndex, readOnlySandboxIndex + 2)).toEqual([
      "--sandbox",
      "read-only"
    ]);
    const readOnlyEnv = JSON.parse(
      await readFile(join(workspaceDir, ".fake-codex-permission-env-0.json"), "utf8")
    ) as { turnPolicy: string | null };
    expect(readOnlyEnv.turnPolicy).toBe("plan-read-tools");

    const approved = await manager.send({
      name: "codex-permission-demo",
      message: "Run the approved write turn.",
      interactionMode: "execute",
      permissionMode: "approve-all",
      contextFiles: []
    });
    const approveAllArgs = JSON.parse(
      await readFile(join(workspaceDir, ".fake-codex-permission-args-1.json"), "utf8")
    ) as string[];
    expect(approveAllArgs).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(approveAllArgs).not.toContain("--sandbox");
    const approveAllEnv = JSON.parse(
      await readFile(join(workspaceDir, ".fake-codex-permission-env-1.json"), "utf8")
    ) as { turnPolicy: string | null };
    expect(approveAllEnv.turnPolicy).toBe("execute-tools");
    expect((approved.details as { session: SessionInfo }).session.permissionMode).toBe(
      "approve-reads"
    );

    await manager.send({
      name: "codex-permission-demo",
      message: "Answer without tools.",
      interactionMode: "execute",
      permissionMode: "deny-all",
      contextFiles: []
    });
    const denyAllArgs = JSON.parse(
      await readFile(join(workspaceDir, ".fake-codex-permission-args-2.json"), "utf8")
    ) as string[];
    const denyAllPrompt = await readFile(
      join(workspaceDir, ".fake-codex-permission-prompt-2.txt"),
      "utf8"
    );
    const denyAllSandboxIndex = denyAllArgs.indexOf("--sandbox");
    expect(denyAllArgs).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(denyAllArgs.slice(denyAllSandboxIndex, denyAllSandboxIndex + 2)).toEqual([
      "--sandbox",
      "read-only"
    ]);
    expect(denyAllPrompt).toContain("Permission mode for this turn is deny-all.");
    expect(denyAllPrompt).toContain("Do not call tools");
    expect(denyAllPrompt).toContain("Answer without tools.");
    const denyAllEnv = JSON.parse(
      await readFile(join(workspaceDir, ".fake-codex-permission-env-2.json"), "utf8")
    ) as { turnPolicy: string | null };
    expect(denyAllEnv.turnPolicy).toBe("deny-all-no-tools");
  });

  it("keeps persistent and direct Codex runtime commands separate", async () => {
    const workspaceDir = await createTempDir("puppenclaw-codex-runtime-env-");
    const codexCommand = await resolveFakeCodexPermissionCommand(workspaceDir);
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const previousPersistent = process.env.PUPPENCLAW_REAL_CODEX_AGENT_COMMAND;
    const previousDirect = process.env.PUPPENCLAW_DIRECT_CODEX_AGENT_COMMAND;
    process.env.PUPPENCLAW_REAL_CODEX_AGENT_COMMAND = "/opt/puppenclaw/codex-acp";
    process.env.PUPPENCLAW_DIRECT_CODEX_AGENT_COMMAND = "/opt/puppenclaw/codex";

    try {
      const manager = new AcpxSessionManager({
        config: makeConfig({ agentCommands: { codex: codexCommand } }),
        logger: {
          info() {},
          warn() {},
          error() {},
          debug() {}
        },
        store,
        outputRouter
      });

      await manager.start({
        agent: "codex",
        name: "codex-runtime-env-demo",
        directory: workspaceDir,
        task: "Capture the isolated runtime environment.",
        contextFiles: [],
        modelProvider: {
          id: "fake-openai-compatible",
          kind: "codex-openai-compatible",
          model: "fake-model"
        }
      });

      const captured = JSON.parse(
        await readFile(join(workspaceDir, ".fake-codex-permission-env-0.json"), "utf8")
      ) as {
        direct: string | null;
        persistent: string | null;
        turnPolicy: string | null;
        modelProviderId: string | null;
        modelProviderModel: string | null;
        modelProviderKind: string | null;
        modelProviderBaseUrl: string | null;
      };
      expect(captured).toEqual({
        direct: "/opt/puppenclaw/codex",
        persistent: "/opt/puppenclaw/codex-acp",
        turnPolicy: "default",
        modelProviderId: "fake-openai-compatible",
        modelProviderModel: "fake-model",
        modelProviderKind: "codex-openai-compatible",
        modelProviderBaseUrl: null
      });
    } finally {
      if (previousPersistent == null) {
        delete process.env.PUPPENCLAW_REAL_CODEX_AGENT_COMMAND;
      } else {
        process.env.PUPPENCLAW_REAL_CODEX_AGENT_COMMAND = previousPersistent;
      }
      if (previousDirect == null) {
        delete process.env.PUPPENCLAW_DIRECT_CODEX_AGENT_COMMAND;
      } else {
        process.env.PUPPENCLAW_DIRECT_CODEX_AGENT_COMMAND = previousDirect;
      }
    }
  });

  it("refreshes and persists a same-id Codex one-shot provider", async () => {
    const workspaceDir = await createTempDir("puppenclaw-provider-refresh-");
    const codexCommand = await resolveFakeCodexPermissionCommand(workspaceDir);
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ agentCommands: { codex: codexCommand } }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    await manager.start({
      agent: "codex",
      name: "provider-refresh-demo",
      directory: workspaceDir,
      task: "Start with the original endpoint.",
      modelProviderId: "local-glm",
      modelProvider: {
        id: "local-glm",
        kind: "codex-openai-compatible",
        model: "old-model",
        baseUrl: "http://127.0.0.1:18000/v1",
        wireApi: "responses"
      },
      contextFiles: []
    });

    const refreshedProvider = {
      id: "local-glm",
      kind: "codex-openai-compatible" as const,
      model: "new-model",
      baseUrl: "http://127.0.0.1:18001/v1",
      wireApi: "responses" as const
    };
    const refreshed = await manager.send({
      name: "provider-refresh-demo",
      message: "Use the refreshed endpoint.",
      modelProviderId: "local-glm",
      modelProvider: refreshedProvider,
      contextFiles: []
    });
    const refreshedSession = (refreshed.details as { session: SessionInfo }).session;
    expect(refreshedSession).toMatchObject({
      model: "new-model",
      modelProviderId: "local-glm",
      modelProvider: refreshedProvider
    });
    const refreshArgs = JSON.parse(
      await readFile(join(workspaceDir, ".fake-codex-permission-args-1.json"), "utf8")
    ) as string[];
    expect(refreshArgs).toContain("new-model");
    const refreshEnv = JSON.parse(
      await readFile(join(workspaceDir, ".fake-codex-permission-env-1.json"), "utf8")
    ) as Record<string, string | null>;
    expect(refreshEnv).toMatchObject({
      modelProviderId: "local-glm",
      modelProviderModel: "new-model",
      modelProviderKind: "codex-openai-compatible",
      modelProviderBaseUrl: "http://127.0.0.1:18001/v1"
    });

    await manager.send({
      name: "provider-refresh-demo",
      message: "Keep using the refreshed endpoint.",
      contextFiles: []
    });
    const persistedEnv = JSON.parse(
      await readFile(join(workspaceDir, ".fake-codex-permission-env-2.json"), "utf8")
    ) as Record<string, string | null>;
    expect(persistedEnv).toMatchObject({
      modelProviderId: "local-glm",
      modelProviderModel: "new-model",
      modelProviderBaseUrl: "http://127.0.0.1:18001/v1"
    });
    expect(store.getSession("provider-refresh-demo")).toMatchObject({
      model: "new-model",
      modelProviderId: "local-glm",
      modelProvider: refreshedProvider
    });
  });

  it("refreshes a same-id Claude Code model and effort without losing transcript", async () => {
    const workspaceDir = await createTempDir(
      "puppenclaw-claude-provider-refresh-"
    );
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });
    const providerId = "claude_code_anthropic";
    await manager.start({
      agent: "claude",
      name: "claude-provider-refresh-demo",
      directory: workspaceDir,
      task: "Start on the old Opus alias.",
      effort: "high",
      model: "opus",
      modelProviderId: providerId,
      modelProvider: {
        id: providerId,
        kind: "claude-code",
        model: "opus"
      },
      contextFiles: []
    });

    const refreshedProvider = {
      id: providerId,
      kind: "claude-code" as const,
      model: "claude-opus-5"
    };
    const refreshed = await manager.send({
      name: "claude-provider-refresh-demo",
      message: "Continue on pinned Opus 5.",
      effort: "low",
      modelProviderId: providerId,
      modelProvider: refreshedProvider,
      contextFiles: []
    });
    const refreshedSession = (refreshed.details as { session: SessionInfo }).session;
    expect(refreshedSession).toMatchObject({
      model: "claude-opus-5",
      effort: "low",
      modelProviderId: providerId,
      modelProvider: refreshedProvider
    });
    expect(
      refreshedSession.transcript.some((entry) => entry.text.includes("old Opus alias"))
    ).toBe(true);
    expect(
      refreshedSession.transcript.some((entry) => entry.text.includes("pinned Opus 5"))
    ).toBe(true);
    const settingPath = (key: string) =>
      join(
        workspaceDir,
        ".fake-acpx-state",
        `claude-provider-refresh-demo.${key}.setting`
      );
    expect(await readFile(settingPath("model"), "utf8")).toBe("claude-opus-5\n");
    expect(await readFile(settingPath("effort"), "utf8")).toBe("low\n");
    expect(store.getSession("claude-provider-refresh-demo")).toMatchObject({
      model: "claude-opus-5",
      effort: "low",
      modelProviderId: providerId,
      modelProvider: refreshedProvider
    });
  });

  it("binds a legacy Claude session to a provider without replacing its runtime", async () => {
    const workspaceDir = await createTempDir(
      "puppenclaw-legacy-claude-refresh-"
    );
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });
    const name = "legacy-claude-provider-refresh-demo";
    await manager.start({
      agent: "claude",
      name,
      directory: workspaceDir,
      task: "Start without provider metadata.",
      effort: "high",
      model: "opus",
      contextFiles: []
    });
    const sessionMarker = join(
      workspaceDir,
      ".fake-acpx-state",
      `${name}.session`
    );
    const markerBefore = await readFile(sessionMarker, "utf8");
    const provider = {
      id: "claude_code_anthropic",
      kind: "claude-code" as const,
      model: "claude-opus-5"
    };

    await manager.send({
      name,
      message: "Continue with the bound Opus 5 provider.",
      effort: "max",
      modelProviderId: provider.id,
      modelProvider: provider,
      contextFiles: []
    });

    expect(await readFile(sessionMarker, "utf8")).toBe(markerBefore);
    expect(store.getSession(name)).toMatchObject({
      model: "claude-opus-5",
      effort: "max",
      modelProviderId: provider.id,
      modelProvider: provider
    });
  });

  it("rejects incomplete, mismatched, cross-provider, and incompatible refreshes", async () => {
    const workspaceDir = await createTempDir("puppenclaw-provider-refresh-reject-");
    const codexCommand = await resolveFakeCodexPermissionCommand(workspaceDir);
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ agentCommands: { codex: codexCommand } }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });
    const originalProvider = {
      id: "local-glm",
      kind: "codex-openai-compatible" as const,
      model: "original-model"
    };
    await manager.start({
      agent: "codex",
      name: "provider-refresh-reject-demo",
      directory: workspaceDir,
      task: "Start with a bound provider.",
      modelProviderId: "local-glm",
      modelProvider: originalProvider,
      contextFiles: []
    });

    await expect(
      manager.send({
        name: "provider-refresh-reject-demo",
        message: "Supply only the provider id.",
        modelProviderId: "local-glm",
        contextFiles: []
      })
    ).rejects.toMatchObject({ code: "MODEL_PROVIDER_REFRESH_INVALID" });
    await expect(
      manager.send({
        name: "provider-refresh-reject-demo",
        message: "Supply mismatched request fields.",
        modelProviderId: "local-glm",
        modelProvider: { ...originalProvider, id: "other-provider" },
        contextFiles: []
      })
    ).rejects.toMatchObject({ code: "MODEL_PROVIDER_REFRESH_INVALID" });
    await expect(
      manager.send({
        name: "provider-refresh-reject-demo",
        message: "Try to rebind the session.",
        modelProviderId: "other-provider",
        modelProvider: { ...originalProvider, id: "other-provider" },
        contextFiles: []
      })
    ).rejects.toMatchObject({ code: "MODEL_PROVIDER_REFRESH_CONFLICT" });
    await expect(
      manager.send({
        name: "provider-refresh-reject-demo",
        message: "Try an unsupported provider kind.",
        modelProviderId: "local-glm",
        modelProvider: {
          id: "local-glm",
          kind: "claude-code",
          model: "claude-model"
        },
        contextFiles: []
      })
    ).rejects.toMatchObject({ code: "MODEL_PROVIDER_REFRESH_UNSUPPORTED" });

    expect(await readFile(join(workspaceDir, ".fake-codex-permission-count"), "utf8")).toBe(
      "1"
    );
    expect(store.getSession("provider-refresh-reject-demo")).toMatchObject({
      modelProviderId: "local-glm",
      modelProvider: originalProvider
    });
  });

  it("closes a legacy persistent Codex runtime before switching to one-shot", async () => {
    const workspaceDir = await createTempDir("puppenclaw-provider-refresh-legacy-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const codexCommand = await resolveFakeCodexPermissionCommand(workspaceDir);
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand, agentCommands: { codex: codexCommand } }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    await manager.start({
      agent: "codex",
      name: "legacy-provider-refresh-demo",
      directory: workspaceDir,
      task: "Start through the persistent ACP runtime.",
      contextFiles: []
    });
    const legacyRuntimePath = join(
      workspaceDir,
      ".fake-acpx-state",
      "legacy-provider-refresh-demo.session"
    );
    expect(await readFile(legacyRuntimePath, "utf8")).toContain("alive");

    const refreshed = await manager.send({
      name: "legacy-provider-refresh-demo",
      message: "Continue through the one-shot provider.",
      modelProviderId: "local-glm",
      modelProvider: {
        id: "local-glm",
        kind: "codex-openai-compatible",
        model: "zai-org/GLM-5.2",
        baseUrl: "http://127.0.0.1:18000/v1",
        wireApi: "responses"
      },
      contextFiles: []
    });
    await expect(readFile(legacyRuntimePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((refreshed.details as { session: SessionInfo }).session).toMatchObject({
      model: "zai-org/GLM-5.2",
      modelProviderId: "local-glm",
      modelProvider: {
        id: "local-glm",
        kind: "codex-openai-compatible"
      }
    });
    expect(
      JSON.parse(
        await readFile(join(workspaceDir, ".fake-codex-permission-env-0.json"), "utf8")
      )
    ).toMatchObject({
      modelProviderId: "local-glm",
      modelProviderModel: "zai-org/GLM-5.2"
    });
  });

  it("fails closed when a legacy persistent runtime cannot be closed", async () => {
    const workspaceDir = await createTempDir("puppenclaw-provider-refresh-close-failure-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const codexCommand = await resolveFakeCodexPermissionCommand(workspaceDir);
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand, agentCommands: { codex: codexCommand } }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });
    const sessionName = "retry-close-provider-refresh";
    await manager.start({
      agent: "codex",
      name: sessionName,
      directory: workspaceDir,
      task: "Start through the persistent ACP runtime.",
      contextFiles: []
    });

    await expect(
      manager.send({
        name: sessionName,
        message: "Do not overlap the persistent and one-shot runtimes.",
        modelProviderId: "local-glm",
        modelProvider: {
          id: "local-glm",
          kind: "codex-openai-compatible",
          model: "zai-org/GLM-5.2"
        },
        contextFiles: []
      })
    ).rejects.toMatchObject({ code: "SIM_CLOSE_FAIL" });
    expect(
      await readFile(
        join(workspaceDir, ".fake-acpx-state", `${sessionName}.session`),
        "utf8"
      )
    ).toContain("alive");
    expect(store.getSession(sessionName)?.modelProvider).toBeUndefined();
    await expect(
      readFile(join(workspaceDir, ".fake-codex-permission-count"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies and persists an Ultra effort override for Codex follow-up turns", async () => {
    const workspaceDir = await createTempDir("puppenclaw-codex-ultra-");
    const codexCommand = await resolveFakeCodexPermissionCommand(workspaceDir);
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ agentCommands: { codex: codexCommand } }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });
    const modelProvider = {
      id: "codex-openai",
      kind: "codex-openai" as const,
      model: "gpt-5.6-sol"
    };

    await manager.start({
      agent: "codex",
      name: "codex-ultra-demo",
      directory: workspaceDir,
      task: "Start with the provider default.",
      contextFiles: [],
      modelProvider
    });

    const upgraded = await manager.send({
      name: "codex-ultra-demo",
      message: "Use Ultra for this and later turns.",
      effort: "ultra",
      contextFiles: []
    });
    const upgradedArgs = JSON.parse(
      await readFile(join(workspaceDir, ".fake-codex-permission-args-1.json"), "utf8")
    ) as string[];
    expect(upgradedArgs).toContain('model_reasoning_effort="ultra"');
    expect((upgraded.details as { session: SessionInfo }).session.effort).toBe("ultra");

    await manager.send({
      name: "codex-ultra-demo",
      message: "Keep the stored effort.",
      contextFiles: []
    });
    const followingArgs = JSON.parse(
      await readFile(join(workspaceDir, ".fake-codex-permission-args-2.json"), "utf8")
    ) as string[];
    expect(followingArgs).toContain('model_reasoning_effort="ultra"');
    expect(store.getSession("codex-ultra-demo")?.effort).toBe("ultra");
  });

  it("skips redundant model and effort control commands on follow-up turns", async () => {
    const workspaceDir = await createTempDir("puppenclaw-skip-redundant-sets-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });
    const settingPath = (key: string) =>
      join(workspaceDir, ".fake-acpx-state", `skip-sets-demo.${key}.setting`);

    await manager.start({
      agent: "claude",
      name: "skip-sets-demo",
      directory: workspaceDir,
      task: "Start with pinned model and effort.",
      model: "claude-opus-4-8",
      effort: "max",
      contextFiles: []
    });
    expect(await readFile(settingPath("model"), "utf8")).toBe("claude-opus-4-8\n");
    expect(await readFile(settingPath("effort"), "utf8")).toBe("max\n");

    await unlink(settingPath("model"));
    await unlink(settingPath("effort"));
    await manager.send({
      name: "skip-sets-demo",
      message: "Same configuration as before.",
      contextFiles: []
    });
    await expect(readFile(settingPath("model"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(settingPath("effort"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });

    await manager.send({
      name: "skip-sets-demo",
      message: "Drop to xhigh from here.",
      effort: "xhigh",
      contextFiles: []
    });
    await expect(readFile(settingPath("model"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await readFile(settingPath("effort"), "utf8")).toBe("xhigh\n");

    await unlink(settingPath("effort"));
    await manager.resume({ name: "skip-sets-demo" });
    expect(await readFile(settingPath("model"), "utf8")).toBe("claude-opus-4-8\n");
    expect(await readFile(settingPath("effort"), "utf8")).toBe("xhigh\n");
  });

  it("fails the turn with MODEL_UNAVAILABLE and ledgers nothing when the adapter rejects a pinned model", async () => {
    const workspaceDir = await createTempDir("puppenclaw-model-reject-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const ledger = await UsageLedgerStore.open(
      await createTempDir("puppenclaw-model-reject-ledger-")
    );
    try {
      const manager = new AcpxSessionManager({
        config: makeConfig({ acpxCommand }),
        logger: {
          info() {},
          warn() {},
          error() {},
          debug() {}
        },
        store,
        outputRouter,
        ledger
      });
      const stateDir = join(workspaceDir, ".fake-acpx-state");
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, "reject-model-set"), "armed\n", "utf8");

      await expect(
        manager.start({
          agent: "claude",
          name: "model-reject-demo",
          directory: workspaceDir,
          task: "This turn must not silently run on the default model.",
          model: "claude-opus-4-8",
          contextFiles: []
        })
      ).rejects.toMatchObject({
        code: "MODEL_UNAVAILABLE",
        details: { agent: "claude", requested: "claude-opus-4-8" }
      });

      // The failed turn never ran, so the ledger records nothing for it.
      expect(ledger.perSessionTotals("model-reject-demo").turns).toBe(0);
      expect(ledger.perSessionHistory("model-reject-demo")).toEqual([]);
      expect(ledger.grandTotals().turns).toBe(0);
      // The failure is loud on the session record too.
      expect(store.getSession("model-reject-demo")?.state).toBe("failed");
      expect(store.getSession("model-reject-demo")?.lastError).toContain("rejected model");
      // The half-configured runtime created for this start was closed again.
      await expect(
        readFile(join(stateDir, "model-reject-demo.session"), "utf8")
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      ledger.close();
    }
  });

  it("keeps the redundant-set skip and resume tolerant when the adapter later rejects the model", async () => {
    const workspaceDir = await createTempDir("puppenclaw-model-reject-late-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const warns: string[] = [];
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn(message: string) {
          warns.push(message);
        },
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });
    const stateDir = join(workspaceDir, ".fake-acpx-state");
    const modelSettingPath = join(stateDir, "late-reject-demo.model.setting");

    // Adapter accepts: explicit model behaves as before.
    await manager.start({
      agent: "claude",
      name: "late-reject-demo",
      directory: workspaceDir,
      task: "Start with a pinned model the adapter accepts.",
      model: "claude-opus-4-8",
      contextFiles: []
    });
    expect(await readFile(modelSettingPath, "utf8")).toBe("claude-opus-4-8\n");

    // Arm rejection AFTER the model was applied. The follow-up turn skips the
    // redundant set (commit 871eb43), so the armed rejection must not fire: an
    // intentionally skipped set is not an error.
    await writeFile(join(stateDir, "reject-model-set"), "armed\n", "utf8");
    await unlink(modelSettingPath);
    await manager.send({
      name: "late-reject-demo",
      message: "Same model as before; the set must be skipped, not rejected.",
      contextFiles: []
    });
    await expect(readFile(modelSettingPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });

    // Resume force-applies config but is a reconnect, not a turn: the
    // rejection downgrades to a warning and resume still succeeds.
    await manager.resume({ name: "late-reject-demo" });
    expect(warns.some((entry) => entry.includes("Unable to set ACPX model"))).toBe(true);
    expect(store.getSession("late-reject-demo")?.state).toBe("idle");

    // The tolerated resume did not mark the model as applied, so the next
    // turn re-attempts the set and fails loudly instead of running.
    await expect(
      manager.send({
        name: "late-reject-demo",
        message: "This turn must fail rather than run on the wrong model.",
        contextFiles: []
      })
    ).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
      details: { agent: "claude", requested: "claude-opus-4-8" }
    });
  });

  it("attempts no model set and keeps default-model tolerance when nothing is pinned", async () => {
    const workspaceDir = await createTempDir("puppenclaw-no-model-pin-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });
    const stateDir = join(workspaceDir, ".fake-acpx-state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "reject-model-set"), "armed\n", "utf8");

    // No model requested: nothing to set, nothing to fail, even though the
    // adapter would reject any model set.
    await manager.start({
      agent: "claude",
      name: "no-model-pin-demo",
      directory: workspaceDir,
      task: "Run on the profile default without pinning a model.",
      contextFiles: []
    });
    await expect(
      readFile(join(stateDir, "no-model-pin-demo.model.setting"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });

    // The literal "default" selector keeps today's warn-and-continue path:
    // running the adapter default IS the requested outcome.
    await manager.start({
      agent: "claude",
      name: "default-model-demo",
      directory: workspaceDir,
      task: "Run on the adapter default via the literal selector.",
      model: "default",
      contextFiles: []
    });
    expect(store.getSession("default-model-demo")?.state).not.toBe("failed");
  });

  it("applies Claude reasoning natively across start, follow-up, resume, and fork", async () => {
    const workspaceDir = await createTempDir("puppenclaw-claude-reasoning-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });
    const settingPath = (name: string) =>
      join(workspaceDir, ".fake-acpx-state", `${name}.effort.setting`);

    const started = await manager.start({
      agent: "claude",
      name: "claude-reasoning-demo",
      directory: workspaceDir,
      task: "Use the selected reasoning mode.",
      effort: "ultra",
      contextFiles: []
    });
    const startedSession = (started.details as { session: SessionInfo }).session;
    expect(await readFile(settingPath("claude-reasoning-demo"), "utf8")).toBe("max\n");
    expect(startedSession).toMatchObject({
      effort: "ultra",
      effectiveEffort: "max",
      runtimeEffort: "max",
      reasoningProfile: "claude"
    });
    expect(startedSession.warnings).toContain(
      'Claude does not define an "ultra" effort level; legacy Ultra was mapped to Claude Max.'
    );

    const upgraded = await manager.send({
      name: "claude-reasoning-demo",
      message: "Use XHigh from this turn onward.",
      effort: "xhigh",
      ultrathink: true,
      contextFiles: []
    });
    const upgradedSession = (upgraded.details as { session: SessionInfo }).session;
    expect(await readFile(settingPath("claude-reasoning-demo"), "utf8")).toBe("xhigh\n");
    expect(upgradedSession).toMatchObject({
      effort: "xhigh",
      effectiveEffort: "xhigh",
      runtimeEffort: "xhigh",
      reasoningProfile: "claude"
    });
    expect(upgradedSession.transcript.at(-2)?.text).toBe("Use XHigh from this turn onward.");

    await unlink(settingPath("claude-reasoning-demo"));
    await manager.resume({ name: "claude-reasoning-demo" });
    expect(await readFile(settingPath("claude-reasoning-demo"), "utf8")).toBe("xhigh\n");

    await manager.fork({
      source: "claude-reasoning-demo",
      target: "claude-reasoning-fork"
    });
    expect(await readFile(settingPath("claude-reasoning-fork"), "utf8")).toBe("xhigh\n");
  });

  it("rejects Claude Ultracode before dispatch when the adapter lacks workflow support", async () => {
    const workspaceDir = await createTempDir("puppenclaw-claude-ultracode-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    await mkdir(join(workspaceDir, ".fake-acpx-state"), { recursive: true });
    await writeFile(join(workspaceDir, ".fake-acpx-state", "reject-workflow-set"), "1");
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    await expect(
      manager.start({
        agent: "claude",
        name: "claude-ultracode-demo",
        directory: workspaceDir,
        task: "Try the workflow mode.",
        effort: "ultracode",
        contextFiles: []
      })
    ).rejects.toMatchObject({
      code: "UNAVAILABLE_REASONING_MODE"
    });
    await expect(
      readFile(
        join(workspaceDir, ".fake-acpx-state", "claude-ultracode-demo.session"),
        "utf8"
      )
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps native Ultracode across resume and fork and clears it for standard/max", async () => {
    const workspaceDir = await createTempDir("puppenclaw-fable-workflow-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({ config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }), logger: { info() {}, warn() {}, error() {}, debug() {} }, store, outputRouter });
    const provider = { id: "fable", kind: "claude-code" as const, model: "claude-fable-5-1" };
    await manager.start({ agent: "claude", name: "workflow", directory: workspaceDir, task: "Begin", effort: "ultracode", model: provider.model, modelProviderId: provider.id, modelProvider: provider, contextFiles: [] });
    const setting = (name: string, key: string) => readFile(join(workspaceDir, ".fake-acpx-state", `${name}.${key}.setting`), "utf8");
    expect(await setting("workflow", "ocsl_workflow_v1")).toBe("ultracode\n");
    expect(await setting("workflow", "effort")).toBe("xhigh\n");
    await manager.resume({ name: "workflow" });
    expect(await setting("workflow", "ocsl_workflow_v1")).toBe("ultracode\n");
    await manager.fork({ source: "workflow", target: "workflow-fork" });
    expect(await setting("workflow-fork", "ocsl_workflow_v1")).toBe("ultracode\n");
    for (const effort of ["max", "high", "ultracode"] as const) {
      await manager.send({ name: "workflow", message: "Continue", effort, contextFiles: [] });
      expect(await setting("workflow", "ocsl_workflow_v1")).toBe(effort === "ultracode" ? "ultracode\n" : "off\n");
      expect(await setting("workflow", "effort")).toBe(`${effort === "ultracode" ? "xhigh" : effort}\n`);
    }
    await expect(manager.send({ name: "workflow", message: "Use Opus", modelProviderId: "fable", modelProvider: { ...provider, model: "claude-opus-5" }, contextFiles: [] })).rejects.toMatchObject({ code: "MODEL_TRANSCRIPT_INCOMPATIBLE" });
    expect(store.getSession("workflow")?.model).toBe("claude-fable-5-1");
    expect(await setting("workflow", "model")).toBe("claude-fable-5-1\n");
  });

  it("uses Codex's native reasoning_effort ACP setting", async () => {
    const workspaceDir = await createTempDir("puppenclaw-codex-native-reasoning-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    await manager.start({
      agent: "codex",
      name: "codex-native-reasoning-demo",
      directory: workspaceDir,
      task: "Use the native Codex setting.",
      effort: "xhigh",
      contextFiles: []
    });

    expect(
      await readFile(
        join(
          workspaceDir,
          ".fake-acpx-state",
          "codex-native-reasoning-demo.reasoning_effort.setting"
        ),
        "utf8"
      )
    ).toBe("xhigh\n");
  });

  it("normalizes GLM-5.2 aliases before launching the Codex-compatible runtime", async () => {
    const workspaceDir = await createTempDir("puppenclaw-glm-reasoning-");
    const codexCommand = await resolveFakeCodexPermissionCommand(workspaceDir);
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ agentCommands: { codex: codexCommand } }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });
    const modelProvider = {
      id: "local-glm",
      kind: "codex-openai-compatible" as const,
      model: "zai-org/GLM-5.2",
      reasoningProfile: "glm-5.2" as const
    };

    const started = await manager.start({
      agent: "codex",
      name: "glm-reasoning-demo",
      directory: workspaceDir,
      task: "Use standard GLM thinking.",
      effort: "low",
      contextFiles: [],
      modelProvider
    });
    const startArgs = JSON.parse(
      await readFile(join(workspaceDir, ".fake-codex-permission-args-0.json"), "utf8")
    ) as string[];
    const startedSession = (started.details as { session: SessionInfo }).session;
    expect(startArgs).toContain('model_reasoning_effort="high"');
    expect(startedSession).toMatchObject({
      effort: "low",
      effectiveEffort: "high",
      runtimeEffort: "high",
      reasoningProfile: "glm-5.2"
    });

    const maximum = await manager.send({
      name: "glm-reasoning-demo",
      message: "Use the maximum GLM tier.",
      effort: "ultracode",
      contextFiles: []
    });
    const maximumArgs = JSON.parse(
      await readFile(join(workspaceDir, ".fake-codex-permission-args-1.json"), "utf8")
    ) as string[];
    expect(maximumArgs).toContain('model_reasoning_effort="max"');
    expect((maximum.details as { session: SessionInfo }).session).toMatchObject({
      effort: "ultracode",
      effectiveEffort: "max",
      runtimeEffort: "max",
      reasoningProfile: "glm-5.2"
    });

    await manager.send({
      name: "glm-reasoning-demo",
      message: "Disable GLM thinking.",
      effort: "none",
      contextFiles: []
    });
    const disabledArgs = JSON.parse(
      await readFile(join(workspaceDir, ".fake-codex-permission-args-2.json"), "utf8")
    ) as string[];
    expect(disabledArgs).toContain('model_reasoning_effort="minimal"');
  });

  it.each([undefined, "none", "low", "medium", "xhigh"] as const)(
    "passes Local LLM effort %s to the native Codex runtime and preserves it on continuation",
    async (effort) => {
      const workspaceDir = await createTempDir("puppenclaw-local-llm-reasoning-");
      const codexCommand = await resolveFakeCodexPermissionCommand(workspaceDir);
      const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
      const manager = new AcpxSessionManager({
        config: makeConfig({ agentCommands: { codex: codexCommand } }),
        logger: {
          info() {},
          warn() {},
          error() {},
          debug() {}
        },
        store,
        outputRouter
      });
      const expectedEffort = effort ?? "medium";
      const started = await manager.start({
        agent: "codex",
        name: "local-llm-reasoning-demo",
        directory: workspaceDir,
        task: "Use the selected local model reasoning level.",
        ...(effort != null ? { effort } : {}),
        contextFiles: [],
        modelProvider: {
          id: "local-llm",
          kind: "codex-openai-compatible",
          model: "chat",
          reasoningProfile: "qwen-3.8"
        }
      });
      const startArgs = JSON.parse(
        await readFile(join(workspaceDir, ".fake-codex-permission-args-0.json"), "utf8")
      ) as string[];
      const expectedSession = {
        effort: expectedEffort,
        effectiveEffort: expectedEffort,
        runtimeEffort: expectedEffort,
        reasoningProfile: "qwen-3.8"
      };
      expect(startArgs).toContain(`model_reasoning_effort="${expectedEffort}"`);
      expect((started.details as { session: SessionInfo }).session).toMatchObject(expectedSession);
      expect(JSON.parse(
        await readFile(join(workspaceDir, ".fake-codex-permission-env-0.json"), "utf8")
      )).toMatchObject({ modelProviderModel: "chat" });

      const continued = await manager.send({
        name: "local-llm-reasoning-demo",
        message: "Continue with the same reasoning level.",
        ultrathink: true,
        contextFiles: []
      });
      const continuationArgs = JSON.parse(
        await readFile(join(workspaceDir, ".fake-codex-permission-args-1.json"), "utf8")
      ) as string[];
      expect(continuationArgs).toContain(`model_reasoning_effort="${expectedEffort}"`);
      expect((continued.details as { session: SessionInfo }).session).toMatchObject(expectedSession);
      expect(await readFile(
        join(workspaceDir, ".fake-codex-permission-prompt-1.txt"),
        "utf8"
      )).not.toContain("Use a high-effort reasoning pass for this reply.");
    }
  );

  it("preserves leading and whitespace-only assistant text chunks", async () => {
    const workspaceDir = await createTempDir("puppenclaw-whitespace-");
    const acpxCommand = await resolveWhitespaceFakeAcpxCommand(workspaceDir);
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const chunks: string[] = [];
    outputRouter.attach("whitespace-demo", async (event) => {
      if (event.kind === "chunk") {
        chunks.push(event.text);
      }
    });
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const result = await manager.start({
      agent: "claude",
      name: "whitespace-demo",
      directory: workspaceDir,
      task: "Emit chunks with leading spaces.",
      contextFiles: []
    });
    const details = result.details as {
      output: string;
    };

    expect(chunks.join("")).toBe("Alpha beta gamma\nNext line");
    expect(details.output).toBe("Alpha beta gamma\nNext line");
  });

  it("exposes live Codex one-shot JSON output while the turn is running", async () => {
    const workspaceDir = await createTempDir("puppenclaw-codex-json-");
    const codexCommand = await resolveFakeCodexJsonCommand(workspaceDir);
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const chunks: string[] = [];
    const structuredEvents: Array<{
      kind: string;
      value?: string;
      text?: string;
      activityType?: string;
    }> = [];
    outputRouter.attach("codex-json-demo", async (event) => {
      if (event.kind === "chunk") {
        chunks.push(event.text);
      } else if (event.kind === "activity") {
        structuredEvents.push({
          kind: event.kind,
          activityType: event.activity.type,
          ...(event.activity.title != null ? { value: event.activity.title } : {}),
          ...(event.activity.text != null ? { text: event.activity.text } : {})
        });
      } else if (event.kind === "final") {
        structuredEvents.push({ kind: event.kind, value: event.text });
      }
    });
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand,
        agentCommands: {
          codex: codexCommand
        }
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const modelProvider = {
      id: "fake-openai-compatible",
      kind: "codex-openai-compatible" as const,
      model: "fake-model",
      baseUrl: "http://example.invalid/v1",
      authTokenEnv: "FAKE_CODEX_TOKEN",
      wireApi: "responses" as const
    };

    await manager.start({
      agent: "codex",
      name: "codex-json-demo",
      directory: workspaceDir,
      task: "Prime the one-shot session.",
      contextFiles: [],
      modelProvider
    });
    chunks.length = 0;
    structuredEvents.length = 0;

    const sendPromise = manager.send({
      name: "codex-json-demo",
      message: "Run a visible tool turn.",
      contextFiles: []
    });

    let liveOutput = "";
    const observedOutputs: Array<{
      attempt: number;
      source: string | undefined;
      complete: boolean | undefined;
      text: string;
    }> = [];
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await sleep(20);
      const output = await manager.output({ name: "codex-json-demo" }).catch(() => null);
      const outputDetails = (output?.details as
        | { output?: { text?: string; source?: string; complete?: boolean } }
        | undefined)?.output;
      liveOutput = outputDetails?.text ?? "";
      if (
        observedOutputs.length === 0 ||
        observedOutputs.at(-1)?.text !== liveOutput ||
        observedOutputs.at(-1)?.source !== outputDetails?.source ||
        observedOutputs.at(-1)?.complete !== outputDetails?.complete
      ) {
        observedOutputs.push({
          attempt,
          source: outputDetails?.source,
          complete: outputDetails?.complete,
          text: liveOutput
        });
      }
      if (liveOutput.includes("Final streamed answer.")) {
        break;
      }
    }

    const runningStatus = await manager.status({ name: "codex-json-demo" });
    const runningDetails = runningStatus.details as {
      session: SessionInfo;
      turn: {
        classification: string;
        lockHeld: boolean;
        processAlive: boolean | null;
        pid: number | null;
      };
    };
    expect(runningDetails.session.state).toBe("running");
    expect(runningDetails.session.activeTurn?.state).toBe("running");
    expect(runningDetails.turn.classification).toBe("running");
    expect(runningDetails.turn.lockHeld).toBe(true);
    expect(runningDetails.turn.processAlive).toBe(true);
    expect(runningDetails.turn.pid).toEqual(expect.any(Number));
    await writeFile(join(workspaceDir, ".fake-codex-json-release"), "release\n", "utf8");

    const result = await sendPromise;
    const details = result.details as {
      output: string;
      session: SessionInfo;
    };

    const completedOutput = await manager.output({ name: "codex-json-demo" });
    const completedText = (
      completedOutput.details as { output: { text: string } }
    ).output.text;
    const visibleSurfaces = JSON.stringify({
      liveOutput,
      observedOutputs,
      chunks,
      completedText,
      result: details.output
    });
    expect(liveOutput, JSON.stringify({ observedOutputs, chunks }, null, 2)).toContain(
      "Final streamed answer."
    );
    expect(completedText).toContain("Final file answer.");
    for (const hiddenProtocolText of [
      "[tool]",
      "[tool output]",
      "LIVE RAW PROGRESS",
      "malformed-stream-secret",
      "should-not-leak",
      "command output line",
      "tool-output-secret",
      "mcp__paper_search_mcp__search_pubmed"
    ]) {
      expect(visibleSurfaces).not.toContain(hiddenProtocolText);
    }
    expect(structuredEvents).toContainEqual({
      kind: "activity",
      activityType: "tool_call",
      value: "exec_command",
      text: expect.stringContaining("Bearer [redacted]") as string
    });
    expect(structuredEvents).toContainEqual({
      kind: "activity",
      activityType: "tool_output",
      text: expect.stringContaining("command output line") as string
    });
    expect(JSON.stringify(structuredEvents)).not.toContain("should-not-leak");
    expect(JSON.stringify(structuredEvents)).not.toContain("tool-output-secret");
    expect(structuredEvents).toContainEqual({ kind: "final", value: "Final file answer." });
    expect(details.output).toBe("Final file answer.");
    expect(details.session.activeTurn?.state).toBe("completed");
    expect(details.session.activeTurn?.completedAt).toBeTruthy();
    expect(details.session.activeTurn?.outputChars).toBeGreaterThan(0);
  });

  it("reports a persisted running turn without its original process as orphaned", async () => {
    const workspaceDir = await createTempDir("puppenclaw-orphaned-turn-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });
    const now = new Date().toISOString();
    await store.upsertSession({
      name: "orphaned-demo",
      agent: "claude",
      directory: workspaceDir,
      state: "running",
      createdAt: now,
      lastActivity: now,
      permissionMode: "approve-reads",
      warnings: [],
      transcript: [],
      activeTurn: {
        id: "lost-turn",
        state: "running",
        startedAt: now,
        updatedAt: now,
        pid: 2_147_483_647,
        processStartIdentity: "2147483647:1",
        outputChars: 0
      }
    });

    const status = await manager.status({ name: "orphaned-demo" });
    const details = status.details as {
      session: SessionInfo;
      turn: {
        classification: string;
        processAlive: boolean | null;
        identityMatches: boolean | null;
        conflict: string | null;
      };
    };
    expect(details.session.state).toBe("failed");
    expect(details.session.activeTurn?.state).toBe("orphaned");
    expect(details.turn.classification).toBe("orphaned");
    expect(details.turn.processAlive).toBe(false);
    expect(details.turn.identityMatches).toBe(false);
    expect(details.turn.conflict).toContain("different process");

    const persisted = store.getSession("orphaned-demo");
    expect(persisted).not.toBeNull();
    expect(manager["isTurnActive"](persisted as SessionInfo)).toBe(false);

    const listed = await manager.status();
    const listedDetails = listed.details as {
      sessions: Array<SessionInfo & { turn: { classification: string } }>;
    };
    const orphaned = listedDetails.sessions.find((entry) => entry.name === "orphaned-demo");
    expect(orphaned?.state).toBe("failed");
    expect(orphaned?.turn.classification).toBe("orphaned");
  });

  it("reports a failed Codex follow-up turn instead of stale prior assistant output", async () => {
    const workspaceDir = await createTempDir("puppenclaw-codex-failure-");
    const codexCommand = await resolveFakeCodexFailureCommand(workspaceDir);
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const chunks: string[] = [];
    const activities: Array<{ type: string; title?: string; text?: string }> = [];
    outputRouter.attach("codex-failure-demo", async (event) => {
      if (event.kind === "chunk") {
        chunks.push(event.text);
      } else if (event.kind === "activity") {
        activities.push({
          type: event.activity.type,
          ...(event.activity.title != null ? { title: event.activity.title } : {}),
          ...(event.activity.text != null ? { text: event.activity.text } : {})
        });
      }
    });
    const manager = new AcpxSessionManager({
      config: makeConfig({
        agentCommands: {
          codex: codexCommand
        }
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });
    const modelProvider = {
      id: "fake-openai-compatible",
      kind: "codex-openai-compatible" as const,
      model: "fake-model",
      baseUrl: "http://example.invalid/v1",
      authTokenEnv: "FAKE_CODEX_TOKEN",
      wireApi: "responses" as const
    };

    await manager.start({
      agent: "codex",
      name: "codex-failure-demo",
      directory: workspaceDir,
      task: "Create the first report.",
      contextFiles: [],
      modelProvider
    });
    chunks.length = 0;
    activities.length = 0;

    const result = await manager.send({
      name: "codex-failure-demo",
      message: "Revise the report.",
      contextFiles: []
    });
    const sendDetails = result.details as {
      session: SessionInfo;
      output: string;
      outputRole: "assistant" | "status";
    };
    expect(sendDetails.session.state).toBe("failed");
    expect(sendDetails.output).toContain("stream disconnected before completion");
    expect(sendDetails.outputRole).toBe("status");

    const output = await manager.output({ name: "codex-failure-demo" });
    const outputDetails = output.details as {
      output: { text: string; source: string; complete: boolean };
    };
    expect(outputDetails.output.source).toBe("active-turn");
    expect(outputDetails.output.complete).toBe(true);
    expect(outputDetails.output.text).toContain("stream disconnected before completion");
    expect(outputDetails.output.text).not.toContain("Initial successful report");
    const visibleSurfaces = JSON.stringify({
      result: sendDetails.output,
      chunks,
      activeOutput: outputDetails.output.text
    });
    for (const hiddenProtocolText of [
      "[tool]",
      "[tool output]",
      "build report",
      "failure-tool-secret",
      "MALFORMED FAILURE",
      "failure-stream-secret"
    ]) {
      expect(visibleSurfaces).not.toContain(hiddenProtocolText);
    }
    expect(activities).toContainEqual({
      type: "tool_call",
      title: "exec_command",
      text: expect.stringContaining("Bearer [redacted]") as string
    });
    expect(JSON.stringify(activities)).not.toContain("failure-tool-secret");
  });

  it("marks a session as waiting_input when the reply is a question", async () => {
    const workspaceDir = await createTempDir("puppenclaw-question-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    await manager.start({
      agent: "claude",
      name: "question-demo",
      directory: workspaceDir,
      task: "Prime the session.",
      contextFiles: []
    });

    const result = await manager.send({
      name: "question-demo",
      message: "ASK_USER",
      contextFiles: []
    });
    const sendDetails = result.details as {
      session: SessionInfo;
      turnSignals: {
        inputRequest: { source: string; toolName: string; text: string };
      };
    };
    expect(sendDetails.session.state).toBe("waiting_input");
    expect(sendDetails.session.activeTurn?.state).toBe("completed");
    expect(sendDetails.session.pendingQuestion).toBe("Which source should I use?");
    expect(sendDetails.turnSignals.inputRequest).toEqual({
      source: "claude-tool",
      toolName: "AskUserQuestion",
      text: "Which source should I use?"
    });
  });

  it("persists terminal process telemetry atomically with the final workflow state", async () => {
    const workspaceDir = await createTempDir("puppenclaw-atomic-turn-state-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const terminalWorkflowStates: SessionInfo["state"][] = [];
    const originalPatchSession = store.patchSession.bind(store);
    store.patchSession = async (...args: Parameters<typeof store.patchSession>) => {
      const result = await originalPatchSession(...args);
      const current = store.getSession(args[0]);
      if (current?.activeTurn != null && current.activeTurn.state !== "running") {
        terminalWorkflowStates.push(current.state);
      }
      return result;
    };
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store,
      outputRouter
    });

    const result = await manager.start({
      agent: "claude",
      name: "atomic-waiting-input",
      directory: workspaceDir,
      task: "ASK_USER",
      contextFiles: []
    });
    const session = (result.details as { session: SessionInfo }).session;

    expect(session).toMatchObject({
      state: "waiting_input",
      activeTurn: { state: "completed" }
    });
    expect(terminalWorkflowStates).toEqual(["waiting_input"]);
    const persisted = JSON.parse(await readFile(join(workspaceDir, "state.json"), "utf8")) as {
      sessions: Record<string, SessionInfo>;
    };
    expect(persisted.sessions["atomic-waiting-input"]).toMatchObject({
      state: "waiting_input",
      activeTurn: { state: "completed" }
    });
  });

  it("preserves Stop and the completed turn when Stop races terminal persistence", async () => {
    const workspaceDir = await createTempDir("puppenclaw-stop-terminal-race-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const originalPatchSession = store.patchSession.bind(store);
    let releaseFinalPatch!: () => void;
    const finalPatchGate = new Promise<void>((resolve) => {
      releaseFinalPatch = resolve;
    });
    let signalFinalPatch!: () => void;
    const finalPatchEntered = new Promise<void>((resolve) => {
      signalFinalPatch = resolve;
    });
    let heldFinalPatch = false;
    store.patchSession = async (name, patch) => {
      const current = store.getSession(name);
      if (name === "stop-terminal-race" && current?.activeTurn?.state === "running") {
        const preview = patch(structuredClone(current));
        if (
          !heldFinalPatch &&
          preview?.activeTurn?.state === "completed" &&
          preview.transcript.length > current.transcript.length
        ) {
          heldFinalPatch = true;
          signalFinalPatch();
          await finalPatchGate;
        }
      }
      return await originalPatchSession(name, patch);
    };
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store,
      outputRouter
    });

    const startOutcome = manager.start({
      agent: "claude",
      name: "stop-terminal-race",
      directory: workspaceDir,
      task: "Finish while Stop races persistence.",
      contextFiles: []
    });
    await finalPatchEntered;
    const stopOutcome = manager.stop({ name: "stop-terminal-race" });
    releaseFinalPatch();
    const [stopped, started] = await Promise.all([stopOutcome, startOutcome]);
    expect((stopped.details as { session: SessionInfo }).session.state).toBe("stopped");
    const startedSession = (started.details as { session: SessionInfo }).session;
    const persisted = store.getSession("stop-terminal-race");

    expect(startedSession.state).toBe("stopped");
    expect(persisted).toMatchObject({
      state: "stopped",
      lastStopReason: "stopped by user",
      activeTurn: { state: "stopped", completedAt: expect.any(String) }
    });
    expect(persisted?.transcript.some((entry) => entry.text.includes("Finish while Stop"))).toBe(
      true
    );
    expect(persisted?.transcript.some((entry) => entry.text.includes("Handled:"))).toBe(true);
  });

  it("rejects resume during a live turn and preserves a concurrent focus lease", async () => {
    const workspaceDir = await createTempDir("puppenclaw-resume-focus-race-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store,
      outputRouter
    });
    const originalRunTurn = manager["runTurn"].bind(manager);
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let signalTurnEntered!: () => void;
    const turnEntered = new Promise<void>((resolve) => {
      signalTurnEntered = resolve;
    });
    manager["runTurn"] = async (params) => {
      signalTurnEntered();
      await turnGate;
      return await originalRunTurn(params);
    };

    const started = manager.start({
      agent: "claude",
      name: "resume-focus-race",
      directory: workspaceDir,
      task: "Finish after the lifecycle mutations.",
      contextFiles: []
    });
    await turnEntered;

    await expect(manager.resume({ name: "resume-focus-race" })).rejects.toMatchObject({
      code: "TURN_ALREADY_RUNNING"
    });
    const focused = await manager.focus({ name: "resume-focus-race", ttlMs: 60_000 });
    const focusedUntil = (focused.details as { session: SessionInfo }).session.focusedUntil;
    releaseTurn();

    const result = await started;
    expect((result.details as { session: SessionInfo }).session.focusedUntil).toBe(focusedUntil);
    expect(store.getSession("resume-focus-race")?.focusedUntil).toBe(focusedUntil);
  });

  it("preserves a concurrent focus-lease removal at terminal persistence", async () => {
    const workspaceDir = await createTempDir("puppenclaw-unfocus-race-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store,
      outputRouter
    });
    await manager.start({
      agent: "claude",
      name: "unfocus-race",
      directory: workspaceDir,
      task: "Prime the focused session.",
      contextFiles: []
    });
    await manager.focus({ name: "unfocus-race", ttlMs: 60_000 });

    const originalRunTurn = manager["runTurn"].bind(manager);
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let signalTurnEntered!: () => void;
    const turnEntered = new Promise<void>((resolve) => {
      signalTurnEntered = resolve;
    });
    manager["runTurn"] = async (params) => {
      signalTurnEntered();
      await turnGate;
      return await originalRunTurn(params);
    };
    const sent = manager.send({
      name: "unfocus-race",
      message: "Finish after the focus lease is removed.",
      contextFiles: []
    });
    await turnEntered;
    await manager.unfocus({ name: "unfocus-race" });
    releaseTurn();

    const result = await sent;
    expect((result.details as { session: SessionInfo }).session.focusedUntil).toBeUndefined();
    expect(store.getSession("unfocus-race")?.focusedUntil).toBeUndefined();
  });

  it("switches advertised Claude modes per turn, restores the baseline, and exposes native plan signals", async () => {
    const workspaceDir = await createTempDir("puppenclaw-native-plan-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const planned = await manager.start({
      agent: "claude",
      name: "native-plan-demo",
      directory: workspaceDir,
      task: "REPORT_NATIVE_MODE",
      interactionMode: "plan",
      contextFiles: []
    });
    const plannedDetails = planned.details as {
      output: string;
      turnSignals: { nativeMode: string };
    };
    expect(plannedDetails.output).toBe("Native mode: plan");
    expect(plannedDetails.turnSignals.nativeMode).toBe("plan");
    expect(
      await readFile(
        join(workspaceDir, ".fake-acpx-state", "native-plan-demo.mode.setting"),
        "utf8"
      )
    ).toBe("default\n");

    const signalled = await manager.send({
      name: "native-plan-demo",
      message: "EXIT_PLAN_MODE",
      interactionMode: "plan",
      contextFiles: []
    });
    const signalledDetails = signalled.details as {
      session: SessionInfo;
      turnSignals: {
        nativeMode: string;
        plan: {
          source: string;
          entries?: Array<{ content: string; status?: string; priority?: string }>;
        };
      };
    };
    expect(signalledDetails.session.state).toBe("idle");
    expect(signalledDetails.session.activeTurn?.state).toBe("completed");
    expect(signalledDetails.turnSignals.nativeMode).toBe("plan");
    expect(signalledDetails.turnSignals.plan).toEqual({
      source: "claude-tool",
      entries: [
        {
          content: "Search primary sources",
          status: "pending",
          priority: "high"
        }
      ]
    });

    const modeSetting = join(
      workspaceDir,
      ".fake-acpx-state",
      "native-plan-demo.mode.setting"
    );
    await writeFile(modeSetting, "plan\n", "utf8");
    const executed = await manager.send({
      name: "native-plan-demo",
      message: "REPORT_NATIVE_MODE",
      interactionMode: "execute",
      permissionMode: "approve-all",
      contextFiles: []
    });
    const executedDetails = executed.details as {
      output: string;
      turnSignals: { nativeMode: string };
    };
    expect(executedDetails.output).toBe("Native mode: default");
    expect(executedDetails.turnSignals.nativeMode).toBe("default");
    expect(await readFile(modeSetting, "utf8")).toBe("plan\n");
  });

  it("trusts exact Claude tool metadata rather than localized or spoofed titles", async () => {
    const workspaceDir = await createTempDir("puppenclaw-native-tool-metadata-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    await manager.start({
      agent: "claude",
      name: "metadata-demo",
      directory: workspaceDir,
      task: "Prime the session.",
      contextFiles: []
    });
    const result = await manager.send({
      name: "metadata-demo",
      message: "SPOOF_PLAN_TITLE",
      contextFiles: []
    });
    const details = result.details as { turnSignals?: { plan?: unknown } };
    expect(details.turnSignals?.plan).toBeUndefined();
  });

  it("restores the Claude native mode after a failed turn outcome", async () => {
    const workspaceDir = await createTempDir("puppenclaw-native-mode-failed-turn-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const result = await manager.start({
      agent: "claude",
      name: "native-mode-failed-turn",
      directory: workspaceDir,
      task: "FAIL_TURN",
      interactionMode: "plan",
      contextFiles: []
    });
    const details = result.details as { session: SessionInfo };
    expect(details.session.state).toBe("failed");
    expect(
      await readFile(
        join(workspaceDir, ".fake-acpx-state", "native-mode-failed-turn.mode.setting"),
        "utf8"
      )
    ).toBe("default\n");
  });

  it("fails before a turn when an advertised native mode transition is rejected", async () => {
    const workspaceDir = await createTempDir("puppenclaw-native-mode-failure-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    await expect(
      manager.start({
        agent: "claude",
        name: "mode-switch-fail",
        directory: workspaceDir,
        task: "Do not run this prompt.",
        interactionMode: "plan",
        contextFiles: []
      })
    ).rejects.toMatchObject({ code: "ACP_MODE_SWITCH_FAILED" });
  });

  it("falls back to prompt and permission enforcement when the ACP runtime advertises no modes", async () => {
    const workspaceDir = await createTempDir("puppenclaw-native-mode-fallback-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const result = await manager.start({
      agent: "claude",
      name: "no-modes-demo",
      directory: workspaceDir,
      task: "REPORT_NATIVE_MODE",
      interactionMode: "plan",
      permissionMode: "approve-reads",
      contextFiles: []
    });
    const details = result.details as {
      output: string;
      session: SessionInfo;
      turnSignals?: { nativeMode?: string };
    };
    expect(details.output).toBe("Native mode: default");
    expect(details.turnSignals?.nativeMode).toBeUndefined();
    expect(details.session.warnings).toContainEqual(
      expect.stringContaining("did not advertise session modes")
    );
  });

  it("classifies ACP error events as status output", async () => {
    const workspaceDir = await createTempDir("puppenclaw-error-role-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const result = await manager.start({
      agent: "claude",
      name: "error-role-demo",
      directory: workspaceDir,
      task: "FAIL_TURN",
      contextFiles: []
    });
    const details = result.details as {
      session: SessionInfo;
      output: string;
      outputRole: "assistant" | "status";
    };

    expect(details.session.state).toBe("failed");
    expect(details.output).toBe("Simulated turn failure");
    expect(details.outputRole).toBe("status");
  });

  it("persists and replays typed Claude OAuth failures", async () => {
    const workspaceDir = await createTempDir("puppenclaw-claude-oauth-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const events: Array<{ kind: string; code?: string; retryable?: boolean; text?: string }> = [];
    outputRouter.attach("oauth-expired-demo", (event) => {
      if (event.kind === "error") {
        events.push(event);
      }
    });
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store,
      outputRouter
    });
    const request = {
      agent: "claude" as const,
      name: "oauth-expired-demo",
      directory: workspaceDir,
      task: "CLAUDE_OAUTH_EXPIRED",
      contextFiles: [],
      turnKey: "oauth:expired"
    };

    const started = await manager.start(request);
    const replayed = await manager.start(request);
    for (const result of [started, replayed]) {
      expect(result.details).toMatchObject({
        session: {
          state: "failed",
          failureCode: "PROVIDER_AUTHENTICATION_REQUIRED",
          retryable: false,
          activeTurn: {
            state: "failed",
            failureCode: "PROVIDER_AUTHENTICATION_REQUIRED",
            retryable: false
          }
        },
        outputRole: "status",
        failureCode: "PROVIDER_AUTHENTICATION_REQUIRED",
        retryable: false
      });
      expect(JSON.stringify(result.details)).not.toContain("must-not-survive");
    }
    expect(started.details).toMatchObject({ turnReceipt: { state: "accepted" } });
    expect(replayed.details).toMatchObject({ turnReceipt: { state: "replayed" } });
    expect(store.getTurnRequest(request.name, request.turnKey)?.outcome).toMatchObject({
      kind: "success",
      failureCode: "PROVIDER_AUTHENTICATION_REQUIRED",
      retryable: false
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "error",
        code: "PROVIDER_AUTHENTICATION_REQUIRED",
        retryable: false
      })
    );
  });

  it("creates a runtime session when acpx status reports no-session", async () => {
    const workspaceDir = await createTempDir("puppenclaw-no-session-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const result = await manager.start({
      agent: "codex",
      name: "fresh-session",
      directory: workspaceDir,
      task: "Reply with exactly OK.",
      contextFiles: []
    });
    const details = result.details as {
      session: SessionInfo;
      output: string;
    };
    expect(details.session.state).toBe("idle");
    expect(details.output).toContain("Handled:");
  });

  it("records planning profiles and injects a plan-first execution prefix", async () => {
    const workspaceDir = await createTempDir("puppenclaw-planning-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const result = await manager.start({
      agent: "claude",
      name: "planner",
      directory: workspaceDir,
      task: "Implement the whole project end to end.",
      planningProfile: "deep",
      contextFiles: []
    });
    const details = result.details as {
      session: SessionInfo;
      output: string;
    };

    expect(details.session.planningProfile).toBe("deep");
    expect(details.output).toContain("deep planning pass first");
    expect(details.output).toContain("only return to the human");
  });

  it("materializes requested Claude Code skills into the session workspace", async () => {
    const workspaceDir = await createTempDir("puppenclaw-skill-workspace-");
    const skillRoot = await createTempDir("puppenclaw-skill-root-");
    const skillDir = join(skillRoot, "oc-science-lab");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: oc-science-lab\n---\n\n# OC Science Lab\n",
      "utf8"
    );
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand,
        skillRoots: [skillRoot]
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const result = await manager.start({
      agent: "claude",
      name: "skill-demo",
      directory: workspaceDir,
      task: "Use the lab skill.",
      contextFiles: [],
      skills: ["oc-science-lab"]
    });
    const details = result.details as {
      session: SessionInfo;
      skills: Array<{ name: string; targetPath: string }>;
    };
    const targetPath = join(workspaceDir, ".claude", "skills", "oc-science-lab", "SKILL.md");

    expect(details.session.skills).toEqual(["oc-science-lab"]);
    expect(details.skills[0]?.targetPath).toBe(targetPath);
    await expect(readFile(targetPath, "utf8")).resolves.toContain("# OC Science Lab");
  });

  it("suspends the least-recent idle runtime session at capacity and rehydrates it on send", async () => {
    const workspaceDir = await createTempDir("puppenclaw-eviction-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand,
        maxSessions: 2
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    await manager.start({
      agent: "claude",
      name: "oldest",
      directory: workspaceDir,
      task: "Prime oldest.",
      contextFiles: []
    });
    await manager.start({
      agent: "claude",
      name: "focused",
      directory: workspaceDir,
      task: "Prime focused.",
      contextFiles: []
    });
    await manager.focus({
      name: "focused",
      ttlMs: 60_000
    });
    await manager.start({
      agent: "claude",
      name: "newcomer",
      directory: workspaceDir,
      task: "Prime newcomer.",
      contextFiles: []
    });

    expect(store.getSession("oldest")?.state).toBe("suspended");
    expect(store.getSession("focused")?.state).toBe("idle");

    const result = await manager.send({
      name: "oldest",
      message: "Continue from previous context.",
      contextFiles: []
    });
    const details = result.details as {
      session: SessionInfo;
      output: string;
    };

    expect(details.session.state).toBe("idle");
    expect(details.output).toContain("was disconnected");
    expect(details.output.replaceAll(" ", "")).toContain("Primeoldest.");
    expect(store.getSession("newcomer")?.state).toBe("suspended");
  });

  it("does not evict focused sessions when every connected slot is protected", async () => {
    const workspaceDir = await createTempDir("puppenclaw-focus-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand,
        maxSessions: 1
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    await manager.start({
      agent: "claude",
      name: "focused-only",
      directory: workspaceDir,
      task: "Prime focused.",
      contextFiles: []
    });
    await manager.focus({
      name: "focused-only",
      ttlMs: 60_000
    });

    await expect(
      manager.start({
        agent: "claude",
        name: "blocked",
        directory: workspaceDir,
        task: "This should not evict focused-only.",
        contextFiles: []
      })
    ).rejects.toThrow(/none can be suspended/u);
  });

  it("serializes simultaneous persistent-runtime capacity admission", async () => {
    const workspaceDir = await createTempDir("puppenclaw-capacity-race-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand: await resolveFakeAcpxCommand(),
        maxSessions: 1
      }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store,
      outputRouter
    });
    const originalInstall = manager["installSessionSkills"].bind(manager);
    let releaseAdmission!: () => void;
    const admissionGate = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let enteredAdmission!: () => void;
    const admissionEntered = new Promise<void>((resolve) => {
      enteredAdmission = resolve;
    });
    manager["installSessionSkills"] = async (...args) => {
      if (manager["capacityReservations"].has("capacity-first")) {
        enteredAdmission();
        await admissionGate;
      }
      return await originalInstall(...args);
    };
    const first = manager.start({
      agent: "claude",
      name: "capacity-first",
      directory: workspaceDir,
      task: "First admitted session.",
      contextFiles: []
    });
    await admissionEntered;

    await expect(
      manager.start({
        agent: "claude",
        name: "capacity-second",
        directory: workspaceDir,
        task: "Must not over-admit.",
        contextFiles: []
      })
    ).rejects.toMatchObject({ code: "MAX_SESSIONS_REACHED" });
    releaseAdmission();
    await first;
    expect(store.getSession("capacity-second")).toBeNull();
    expect(manager["capacityReservations"].size).toBe(0);

    manager["installSessionSkills"] = async () => {
      throw new Error("simulated post-admission failure");
    };
    await expect(
      manager.start({
        agent: "claude",
        name: "capacity-error",
        directory: workspaceDir,
        task: "Fail after reserving capacity.",
        contextFiles: []
      })
    ).rejects.toThrow("simulated post-admission failure");
    expect(manager["capacityReservations"].size).toBe(0);
  });

  it("serializes capacity eviction with lifecycle mutation of the victim", async () => {
    const workspaceDir = await createTempDir("puppenclaw-capacity-eviction-race-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand: await resolveFakeAcpxCommand(),
        maxSessions: 1
      }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store,
      outputRouter
    });
    await manager.start({
      agent: "claude",
      name: "eviction-victim",
      directory: workspaceDir,
      task: "Hold the only slot.",
      contextFiles: []
    });
    const originalSuspend = manager["suspendTrackedSession"].bind(manager);
    let releaseEviction!: () => void;
    const evictionGate = new Promise<void>((resolve) => {
      releaseEviction = resolve;
    });
    let signalEviction!: () => void;
    const evictionEntered = new Promise<void>((resolve) => {
      signalEviction = resolve;
    });
    manager["suspendTrackedSession"] = async (...args) => {
      if (args[0].name === "eviction-victim") {
        signalEviction();
        await evictionGate;
      }
      return await originalSuspend(...args);
    };

    const newcomer = manager.start({
      agent: "claude",
      name: "eviction-newcomer",
      directory: workspaceDir,
      task: "Claim the slot after eviction.",
      contextFiles: []
    });
    await evictionEntered;
    let stopFinished = false;
    const stopVictim = manager.stop({ name: "eviction-victim" }).then((result) => {
      stopFinished = true;
      return result;
    });
    await sleep(25);
    expect(stopFinished).toBe(false);

    releaseEviction();
    await newcomer;
    await stopVictim;
    expect(store.getSession("eviction-victim")?.state).toBe("stopped");
    expect(store.getSession("eviction-newcomer")?.state).toBe("idle");
    expect(manager["capacityReservations"].size).toBe(0);
  });

  it("does not charge one-shot logical sessions against persistent capacity", async () => {
    const workspaceDir = await createTempDir("puppenclaw-one-shot-capacity-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand: await resolveFakeAcpxCommand(),
        agentCommands: { codex: await resolveFakeCodexPermissionCommand(workspaceDir) },
        maxSessions: 1
      }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store,
      outputRouter
    });
    await manager.start({
      agent: "claude",
      name: "persistent-slot",
      directory: workspaceDir,
      task: "Hold the persistent worker slot.",
      contextFiles: []
    });

    await expect(
      manager.start({
        agent: "codex",
        name: "logical-one-shot",
        directory: workspaceDir,
        task: "Run independently.",
        modelProvider: {
          id: "one-shot-provider",
          kind: "codex-openai",
          model: "fake-model"
        },
        contextFiles: []
      })
    ).resolves.toMatchObject({ details: { session: { state: "idle" } } });
    expect(store.getSession("persistent-slot")?.state).toBe("idle");
  });

  it("claims competing fork targets and includes the latest completed source turn", async () => {
    const workspaceDir = await createTempDir("puppenclaw-fork-race-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand(), maxSessions: 5 }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store,
      outputRouter
    });
    await manager.start({
      agent: "claude",
      name: "fork-source-latest",
      directory: workspaceDir,
      task: "Initial source context.",
      contextFiles: []
    });
    const sourceTurn = manager.send({
      name: "fork-source-latest",
      message: "SLOW_TURN latest source context",
      contextFiles: []
    });
    const slowMarker = join(workspaceDir, ".fake-acpx-state", "fork-source-latest.slow");
    let sourceTurnStarted = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await readFile(slowMarker, "utf8").then(
        () => true,
        () => false
      )) {
        sourceTurnStarted = true;
        break;
      }
      await sleep(10);
    }
    expect(sourceTurnStarted).toBe(true);
    const forkOne = manager.fork({ source: "fork-source-latest", target: "shared-target" });
    const forkTwo = manager.fork({ source: "fork-source-latest", target: "shared-target" });
    const forkOutcomes = Promise.allSettled([forkOne, forkTwo]);
    await manager.stop({ name: "fork-source-latest" });
    await sourceTurn.catch(() => undefined);
    const outcomes = await forkOutcomes;

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(
      (outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason
    ).toMatchObject({ code: "FORK_TARGET_CLAIMED" });
    const target = store.getSession("shared-target");
    expect(target).not.toBeNull();
    expect(target?.transcript.some((entry) => entry.text.includes("latest source context"))).toBe(
      true
    );
  });

  it("releases the source lifecycle lock before running the fork target turn", async () => {
    const workspaceDir = await createTempDir("puppenclaw-fork-source-lock-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand(), maxSessions: 3 }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store,
      outputRouter
    });
    await manager.start({
      agent: "claude",
      name: "fork-lock-source",
      directory: workspaceDir,
      task: "SLOW_FORK_TARGET snapshot context",
      contextFiles: []
    });

    const fork = manager.fork({ source: "fork-lock-source", target: "fork-lock-target" });
    const observedFork = fork.then(
      () => null,
      (error: unknown) => error
    );
    const targetSlowMarker = join(
      workspaceDir,
      ".fake-acpx-state",
      "fork-lock-target.slow"
    );
    let targetStarted = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await readFile(targetSlowMarker, "utf8").then(
        () => true,
        () => false
      )) {
        targetStarted = true;
        break;
      }
      await sleep(10);
    }
    expect(targetStarted).toBe(true);

    const stoppedSource = await Promise.race([
      manager.stop({ name: "fork-lock-source" }),
      sleep(1_000).then(() => {
        throw new Error("Stop remained blocked behind the fork target turn.");
      })
    ]);
    expect((stoppedSource.details as { session: SessionInfo }).session.state).toBe("stopped");

    await manager.stop({ name: "fork-lock-target" });
    await observedFork;
    expect(store.getSession("fork-lock-source")?.state).toBe("stopped");
  });

  it("survives a prompt child that exits before reading stdin (EPIPE)", async () => {
    const workspaceDir = await createTempDir("puppenclaw-epipe-");
    const fakeAcpxPath = join(workspaceDir, "fake-epipe-acpx.mjs");
    await writeFile(
      fakeAcpxPath,
      `#!/usr/bin/env node
import { writeSync } from "node:fs";

const args = process.argv.slice(2);
const commandIndex = args.findIndex((arg) => ["status", "sessions", "prompt"].includes(arg));
const command = commandIndex >= 0 ? args.slice(commandIndex) : [];

function emit(value) {
  writeSync(1, JSON.stringify(value) + "\\n");
}

if (command[0] === "status") {
  emit({ status: "alive", summary: "ready" });
  process.exit(0);
}
if (command[0] === "sessions" && command[1] === "new") {
  emit({ status: "alive" });
  process.exit(0);
}
if (command[0] === "sessions" && command[1] === "show") {
  emit({ messages: [] });
  process.exit(0);
}
if (command[0] === "sessions" && command[1] === "history") {
  emit({ entries: [] });
  process.exit(0);
}
if (command[0] === "prompt") {
  // Exit immediately WITHOUT reading stdin: the manager's prompt write
  // then fails with EPIPE, which must not crash the process.
  process.exit(1);
}
process.exit(1);
`,
      "utf8"
    );
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand: `node "${fakeAcpxPath.replaceAll('"', '\\"')}"`
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    // A prompt far larger than the OS pipe buffer guarantees the child exits
    // while the write is still in flight.
    const result = await manager.start({
      agent: "claude",
      name: "epipe-demo",
      directory: workspaceDir,
      task: `Summarize: ${"x".repeat(1_500_000)}`,
      contextFiles: []
    });
    const details = result.details as {
      session: SessionInfo;
      outputRole: "assistant" | "status";
    };
    expect(details.session.state).toBe("failed");
    expect(details.outputRole).toBe("status");
  });

  it("gc skips sessions with in-flight turns and clears tracking maps for reaped sessions", async () => {
    const workspaceDir = await createTempDir("puppenclaw-gc-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand,
        sessionTtlMinutes: 1
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const staleActivity = new Date(Date.now() - 10 * 60_000).toISOString();
    const baseSession = {
      agent: "claude" as const,
      directory: workspaceDir,
      state: "completed" as const,
      createdAt: staleActivity,
      lastActivity: staleActivity,
      permissionMode: "approve-reads" as const,
      warnings: [],
      transcript: []
    };
    await store.upsertSession({ ...baseSession, name: "busy" });
    await store.upsertSession({ ...baseSession, name: "stale" });

    // Simulate an in-flight turn for "busy": send()/start() hold the turn
    // lock for the whole turn without touching the stored state.
    manager["activeTurns"].add("busy");
    manager["activeTurnOutputs"].set("stale", {
      sessionName: "stale",
      text: "leftover output",
      startedAt: staleActivity,
      updatedAt: staleActivity,
      complete: true,
      totalChars: "leftover output".length
    });

    await manager.gc();

    expect(store.getSession("busy")).not.toBeNull();
    expect(store.getSession("stale")).toBeNull();
    expect(manager["activeTurnOutputs"].has("stale")).toBe(false);
    expect(manager["activeTurnProcesses"].has("stale")).toBe(false);

    // Once the turn is no longer in flight, the session becomes reapable.
    manager["activeTurns"].delete("busy");
    await manager.gc();
    expect(store.getSession("busy")).toBeNull();
  });

  it("joins a concurrent duplicate turn key and replays its durable result after restart", async () => {
    const workspaceDir = await createTempDir("puppenclaw-keyed-join-");
    const config = makeConfig({ acpxCommand: await resolveFakeAcpxCommand() });
    const first = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      ...first
    });
    const originalRunTurn = manager["runTurn"].bind(manager);
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const startedRun = new Promise<void>((resolve) => {
      entered = resolve;
    });
    manager["runTurn"] = async (params) => {
      runs += 1;
      entered();
      await gate;
      return await originalRunTurn(params);
    };
    const request = {
      agent: "claude" as const,
      name: "keyed-join",
      directory: workspaceDir,
      task: "Execute this request once.",
      contextFiles: [],
      turnKey: "queue:join-1"
    };
    const original = manager.start(request);
    await startedRun;
    const duplicate = manager.start({ ...request, lifecycleEpoch: 99 });
    release();
    const [accepted, replayed] = await Promise.all([original, duplicate]);

    expect(runs).toBe(1);
    expect(accepted.details).toMatchObject({
      turnReceipt: { turnKey: request.turnKey, state: "accepted" }
    });
    expect(replayed.details).toMatchObject({
      turnReceipt: { turnKey: request.turnKey, state: "replayed" }
    });
    expect((accepted.details as { output: string }).output).toBe(
      (replayed.details as { output: string }).output
    );

    await first.store.close();
    const second = await createStoreAndRouter(workspaceDir);
    const restarted = new AcpxSessionManager({
      config,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      ...second
    });
    const durableReplay = await restarted.start({ ...request, lifecycleEpoch: 1234 });
    expect(durableReplay.details).toMatchObject({
      turnReceipt: { turnKey: request.turnKey, state: "replayed" }
    });
    await expect(
      restarted.start({ ...request, task: "Conflicting request body." })
    ).rejects.toMatchObject({ code: "TURN_KEY_CONFLICT" });
    await second.store.close();
  });

  it("replays waiting-input and failed keyed outcomes without another dispatch", async () => {
    const workspaceDir = await createTempDir("puppenclaw-keyed-outcomes-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store,
      outputRouter
    });
    const waitingRequest = {
      agent: "claude" as const,
      name: "keyed-waiting",
      directory: workspaceDir,
      task: "ASK_USER",
      contextFiles: [],
      turnKey: "queue:waiting"
    };
    const waiting = await manager.start(waitingRequest);
    const waitingReplay = await manager.start(waitingRequest);
    expect(waiting.details).toMatchObject({
      session: { state: "waiting_input" },
      turnSignals: { inputRequest: { toolName: "AskUserQuestion" } },
      turnReceipt: { state: "accepted" }
    });
    expect(waitingReplay.details).toMatchObject({
      session: { state: "waiting_input" },
      turnSignals: { inputRequest: { toolName: "AskUserQuestion" } },
      turnReceipt: { state: "replayed" }
    });

    const planRequest = {
      name: "keyed-waiting",
      message: "EXIT_PLAN_MODE",
      interactionMode: "plan" as const,
      contextFiles: [],
      turnKey: "queue:plan"
    };
    const plan = await manager.send(planRequest);
    const planReplay = await manager.send(planRequest);
    const expectedPlan = {
      session: { state: "idle", activeTurn: { state: "completed" } },
      turnSignals: {
        nativeMode: "plan",
        plan: {
          source: "claude-tool",
          entries: [
            { content: "Search primary sources", status: "pending", priority: "high" }
          ]
        }
      }
    };
    expect(plan.details).toMatchObject({
      ...expectedPlan,
      turnReceipt: { turnKey: planRequest.turnKey, state: "accepted" }
    });
    expect(planReplay.details).toMatchObject({
      ...expectedPlan,
      turnReceipt: { turnKey: planRequest.turnKey, state: "replayed" }
    });

    const failureRequest = {
      name: "keyed-waiting",
      message: "Trigger a provider exception exactly once.",
      contextFiles: [],
      turnKey: "queue:failure"
    };
    let failures = 0;
    manager["runTurn"] = async (params) => {
      failures += 1;
      await manager["startActiveTurnOutput"](params.session);
      throw new PuppenclawError(
        "TEST_POST_DISPATCH_FAILURE",
        "Provider failed after active-turn publication."
      );
    };
    await expect(manager.send(failureRequest)).rejects.toMatchObject({
      code: "TEST_POST_DISPATCH_FAILURE",
      details: { turnReceipt: { turnKey: "queue:failure", state: "accepted" } }
    });
    await expect(manager.send(failureRequest)).rejects.toMatchObject({
      code: "TEST_POST_DISPATCH_FAILURE",
      details: { turnReceipt: { turnKey: "queue:failure", state: "replayed" } }
    });
    expect(failures).toBe(1);
  });

  it("lets Stop fence a keyed start before provider dispatch", async () => {
    const workspaceDir = await createTempDir("puppenclaw-keyed-stop-pre-dispatch-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store,
      outputRouter
    });
    const originalRunTurn = manager["runTurn"].bind(manager);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const reachedPreDispatch = new Promise<void>((resolve) => {
      entered = resolve;
    });
    manager["runTurn"] = async (params) => {
      entered();
      await gate;
      return await originalRunTurn(params);
    };
    const start = manager.start({
      agent: "claude",
      name: "keyed-stop",
      directory: workspaceDir,
      task: "Must never dispatch after Stop wins.",
      contextFiles: [],
      turnKey: "queue:stopped"
    });
    await reachedPreDispatch;
    const stop = manager.stop({ name: "keyed-stop" });
    release();
    await expect(start).rejects.toMatchObject({
      code: "TURN_ABORTED",
      details: { turnReceipt: { state: "accepted" } }
    });
    await expect(stop).resolves.toMatchObject({ details: { session: { state: "stopped" } } });
    expect(store.getSession("keyed-stop")).toMatchObject({ state: "stopped" });
    expect(store.getTurnRequest("keyed-stop", "queue:stopped")?.state).toBe("settled");
  });

  it("lets Stop fence a keyed start before its provisional session is published", async () => {
    const workspaceDir = await createTempDir("puppenclaw-keyed-stop-unpublished-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store,
      outputRouter
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const claimed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    manager["installSessionSkills"] = async () => {
      entered();
      await gate;
      return [];
    };
    const start = manager.start({
      agent: "claude",
      name: "unpublished-stop",
      directory: workspaceDir,
      task: "Never publish this session after Stop.",
      contextFiles: [],
      turnKey: "queue:unpublished"
    });
    await claimed;
    const stop = manager.stop({ name: "unpublished-stop" });
    release();

    await expect(start).rejects.toMatchObject({
      code: "TURN_ABORTED",
      details: { turnReceipt: { state: "accepted" } }
    });
    await expect(stop).resolves.toMatchObject({
      details: { sessionName: "unpublished-stop", stopped: true }
    });
    expect(store.getSession("unpublished-stop")).toBeNull();
    expect(store.getTurnRequest("unpublished-stop", "queue:unpublished")).toMatchObject({
      state: "settled",
      outcome: { kind: "error", code: "TURN_ABORTED" }
    });
  });

  it("publishes a status result when an exit-0 Codex one-shot turn produces no final message", async () => {
    const workspaceDir = await createTempDir("puppenclaw-codex-empty-final-");
    const codexCommand = await resolveFakeCodexEmptyFinalCommand(workspaceDir);
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand,
        agentCommands: {
          codex: codexCommand
        }
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });
    const modelProvider = {
      id: "fake-openai-compatible",
      kind: "codex-openai-compatible" as const,
      model: "fake-model",
      baseUrl: "http://example.invalid/v1",
      authTokenEnv: "FAKE_CODEX_TOKEN",
      wireApi: "responses" as const
    };

    await manager.start({
      agent: "codex",
      name: "codex-empty-final-demo",
      directory: workspaceDir,
      task: "Prime the one-shot session.",
      contextFiles: [],
      modelProvider
    });

    // The second invocation exits 0 without an assistant message and without
    // writing --output-last-message: the turn must surface as a status result,
    // never as an assistant reply a consumer could confuse with the previous
    // turn's final message.
    const result = await manager.send({
      name: "codex-empty-final-demo",
      message: "Run the approved work.",
      contextFiles: []
    });
    const details = result.details as {
      output: string;
      outputRole: "assistant" | "status";
      turnSignals?: { stopReason?: string };
      session: SessionInfo;
    };

    expect(details.outputRole).toBe("status");
    expect(details.output).toBe("Runner completed without a final assistant message.");
    expect(details.turnSignals?.stopReason).toBe("no_final_message");
    expect(details.session.state).toBe("idle");
    expect(
      details.session.transcript
        .filter((entry) => entry.role === "assistant")
        .map((entry) => entry.text)
    ).toEqual(["First answer."]);
    expect(details.session.transcript.at(-1)).toMatchObject({
      role: "status",
      text: "Runner completed without a final assistant message."
    });

    const output = await manager.output({ name: "codex-empty-final-demo" });
    const outputDetails = (
      output.details as {
        output?: {
          text?: string;
          source?: string;
          turnId?: string | null;
          withinActiveTurn?: boolean;
        };
      }
    ).output;
    expect(outputDetails?.text).toContain("without a final assistant message");

    // Turn provenance is stamped end to end: the turn's own entries carry its
    // id, and the served transcript output identifies as within that turn.
    const sessionAfter = store.getSession("codex-empty-final-demo");
    const sendTurnId = sessionAfter?.activeTurn?.id;
    expect(sendTurnId).toBeTruthy();
    const stampedEntries = details.session.transcript.filter(
      (entry) => entry.turnId === sendTurnId
    );
    expect(stampedEntries.at(-1)).toMatchObject({ role: "status" });
    expect(outputDetails?.source).toBe("transcript");
    expect(outputDetails?.turnId).toBe(sendTurnId);
    expect(outputDetails?.withinActiveTurn).toBe(true);

    // A newest response entry that predates the reported turn is flagged as
    // outside it — the signal consumers use to reject resurrected text.
    if (sessionAfter?.activeTurn == null) {
      throw new Error("expected active turn metadata after the send turn");
    }
    await store.upsertSession({
      ...sessionAfter,
      activeTurn: {
        ...sessionAfter.activeTurn,
        id: "later-turn"
      }
    });
    const staleOutput = await manager.output({ name: "codex-empty-final-demo" });
    const staleProvenance = (
      staleOutput.details as {
        output?: { source?: string; withinActiveTurn?: boolean };
      }
    ).output;
    expect(staleProvenance?.source).toBe("transcript");
    expect(staleProvenance?.withinActiveTurn).toBe(false);

    // Persisted entries keep their turn ids (every persist round-trips
    // through the strict stored-state schema, so this also proves the schema
    // accepts the stamp).
    const persisted = JSON.parse(
      await readFile(join(workspaceDir, "state.json"), "utf8")
    ) as {
      sessions: Record<
        string,
        { transcript: Array<{ turnId?: string }> }
      >;
    };
    expect(
      persisted.sessions["codex-empty-final-demo"]?.transcript.filter(
        (entry) => entry.turnId != null
      ).length ?? 0
    ).toBeGreaterThan(0);
  });

  it("publishes a status result for an empty ACP turn", async () => {
    const workspaceDir = await createTempDir("puppenclaw-empty-acp-turn-");
    const acpxCommand = await resolveEmptyTurnFakeAcpxCommand(workspaceDir);
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter
    });

    const result = await manager.start({
      agent: "codex",
      name: "empty-acp-demo",
      directory: workspaceDir,
      task: "Run a turn that emits no message.",
      contextFiles: []
    });
    const details = result.details as {
      output: string;
      outputRole: "assistant" | "status";
      turnSignals?: { stopReason?: string };
      session: SessionInfo;
    };

    expect(details.outputRole).toBe("status");
    expect(details.output).toBe("Runner completed without a final assistant message.");
    expect(details.turnSignals?.stopReason).toBe("no_final_message");
    expect(details.session.state).toBe("idle");
    expect(details.session.transcript.at(-1)).toMatchObject({
      role: "status",
      text: "Runner completed without a final assistant message."
    });
  });
});
