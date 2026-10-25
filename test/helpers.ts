import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionStore } from "../src/shared/store.js";
import { pluginConfigZod } from "../src/shared/schema.js";
import { OutputRouter } from "../src/plugin/output-router.js";

export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function resolveFakeAcpxCommand(): Promise<string> {
  const fixtureDir = dirname(fileURLToPath(import.meta.url));
  if (process.platform === "win32") {
    const filePath = resolve(fixtureDir, "./fixtures/fake-acpx.mjs");
    return `node ${quoteCommandPart(filePath)}`;
  }
  const filePath = resolve(fixtureDir, "./fixtures/fake-acpx.sh");
  await chmod(filePath, 0o755);
  return filePath;
}

/** The streaming fake runner (test/fixtures/fake-acpx-stream.mjs), run with this Node binary. */
export function resolveFakeAcpxStreamCommand(): string {
  const fixtureDir = dirname(fileURLToPath(import.meta.url));
  return `${quoteCommandPart(process.execPath)} ${quoteCommandPart(
    resolve(fixtureDir, "./fixtures/fake-acpx-stream.mjs")
  )}`;
}

function quoteCommandPart(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,\\-]+$/u.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}

export async function createStoreAndRouter(rootDir: string): Promise<{
  store: SessionStore;
  outputRouter: OutputRouter;
}> {
  return {
    store: await SessionStore.open(rootDir),
    outputRouter: new OutputRouter({
      info() {},
      warn() {},
      error() {},
      debug() {}
    })
  };
}

export function makeConfig(overrides: Record<string, unknown> = {}) {
  return pluginConfigZod.parse({
    backend: "local",
    daemonUrl: "http://127.0.0.1:18795",
    defaultAgent: "claude",
    maxSessions: 5,
    permissionMode: "approve-reads",
    sessionTtlMinutes: 60,
    streamOutput: true,
    acpxCommand: undefined,
    agentCommands: {},
    mcpServers: {},
    remoteControl: {
      mediated: {
        enabled: true
      },
      purePipe: {
        enabled: false,
        allowFrom: [],
        allowedAgents: []
      },
      requireConversationBinding: true
    },
    ...overrides
  });
}

export function nodePrintCommand(text: string): string {
  return `node -e "process.stdout.write(Buffer.from('${base64(text)}','base64').toString('utf8'))"`;
}

export function nodeFileExistsCommand(path: string): string {
  return `node -e "if(!require('node:fs').existsSync(Buffer.from('${base64(
    path
  )}','base64').toString('utf8')))process.exit(1)"`;
}

export function nodeStdinToNullAndPrintCommand(text: string): string {
  return `node -e "process.stdin.resume();process.stdin.on('end',function(){process.stdout.write(Buffer.from('${base64(
    text
  )}','base64').toString('utf8'))})"`;
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** A minimal persisted session as SessionStore validates it. */
export function seedSession(
  name: string,
  directory: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const at = "2026-10-25T10:00:00.000Z";
  return {
    name,
    agent: "claude",
    directory,
    state: "idle",
    createdAt: at,
    lastActivity: at,
    permissionMode: "approve-reads",
    warnings: [],
    transcript: [],
    ...overrides
  };
}

/** Seeds `<dataDir>/state.json` with the given sessions (keyed by name). */
export async function writeSeedState(
  dataDir: string,
  sessions: Array<Record<string, unknown>>
): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(dataDir, "state.json"),
    JSON.stringify({
      version: 1,
      sessions: Object.fromEntries(sessions.map((session) => [session.name as string, session])),
      turnRequests: {},
      turnGenerations: {},
      exposures: {},
      quiescence: { lastEpoch: 0, active: {}, latestByName: {} }
    }),
    "utf8"
  );
}

/** `count` transcript entries of `chars` characters each, alternating user and assistant. */
export function seedTranscript(count: number, chars: number, turnId?: string): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `${index}:`.padEnd(chars, "x"),
    createdAt: new Date(Date.parse("2026-10-25T10:00:00.000Z") + index * 1_000).toISOString(),
    ...(turnId != null ? { turnId } : {})
  }));
}

/**
 * SSE body reduced to one string per event: kind plus visible text, activity
 * type and title, error code, or the result's output.
 */
export function normalizeSse(body: string): string[] {
  return body
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>)
    .map((event) => {
      switch (event.kind) {
        case "result":
          return `result:${JSON.stringify((event.result as { details: { output?: unknown } }).details.output)}`;
        case "activity": {
          const activity = event.activity as { type: string; title?: string; text?: string };
          return `activity:${activity.type}:${activity.title ?? activity.text ?? ""}`;
        }
        case "error":
          return `error:${String(event.code)}`;
        case "done":
          return "done";
        default:
          return `${String(event.kind)}:${JSON.stringify(event.text)}`;
      }
    });
}
