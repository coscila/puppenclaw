/**
 * Emits contract fixtures for the daemon's session status and output envelopes.
 *
 * Run with: npx tsx scripts/emit-contract-fixtures.ts
 *
 * The generator seeds a session store with one session per scenario, boots the
 * real daemon HTTP server (createDaemonServer) against it, and captures the
 * exact JSON bodies of GET /session/:name, GET /session/:name?view=summary and
 * GET /session/:name/output via
 * Fastify's inject — the same route handlers, manager methods, and envelope
 * builders that serve production traffic. Consumer-side contract tests can
 * treat the committed fixtures as the daemon's authoritative wire format;
 * test/unit/contract-fixtures.test.ts regenerates them in-memory and fails
 * when the emitted shape drifts.
 *
 * Determinism post-processing applied to the captured bodies (both the
 * details payload and the JSON echoed inside content[0].text):
 * - the temporary workspace directory is replaced with /workspace/project;
 * - the live turn process's pid, process group id, and process start identity
 *   are replaced with the fixed values 431602, 431600, and "431602:8888888";
 * - turn.ageMs and turn.outputAgeMs (computed from Date.now() against the
 *   fixed seeded timestamps) are replaced with 61000 and 32000.
 * All other values are seeded with fixed timestamps and are deterministic.
 *
 * Requires Linux: turn liveness classification probes /proc process identity.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createDaemonServer } from "../src/daemon/server.js";
import { AcpxSessionManager } from "../src/manager/acpx.js";
import type { ActiveTurnMetadata, SessionInfo } from "../src/shared/types.js";
import {
  createStoreAndRouter,
  makeConfig,
  resolveFakeAcpxCommand
} from "../test/helpers.js";

export const CONTRACT_SCENARIOS = [
  "idle",
  "plan",
  "waiting-input",
  "lost-stream",
  "running",
  "orphaned",
  "legacy-no-turn",
  "failed",
  "quiesced"
] as const;

export type ContractScenario = (typeof CONTRACT_SCENARIOS)[number];

export type ContractCapture = {
  status: unknown;
  output: unknown;
  /** GET /session/:name?view=summary, the compact pcp/2 step-1 status view. */
  summary: unknown;
};

export const CONTRACT_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "fixtures",
  "contract"
);

const FIXED_WORKSPACE = "/workspace/project";
const FIXED_PID = 431_602;
const FIXED_PROCESS_GROUP_ID = FIXED_PID;
const FIXED_PROCESS_START_IDENTITY = "431602:8888888";
const FIXED_AGE_MS = 61_000;
const FIXED_OUTPUT_AGE_MS = 32_000;
const DEAD_PID = 999_999_999;
const FIXED_BOOT_ID = "00000000-0000-4000-8000-000000000001";
const FIXED_SPOOL_ID = "00000000-0000-4000-8000-000000000002";

const T_CREATED = "2026-01-01T10:00:00.000Z";
const T_USER = "2026-01-01T10:00:05.000Z";
const T_ASSISTANT = "2026-01-01T10:00:20.000Z";
const T_TURN_STARTED = "2026-01-01T10:01:00.000Z";
const T_TURN_OUTPUT = "2026-01-01T10:01:30.000Z";
const T_LAST_ACTIVITY = "2026-01-01T10:02:00.000Z";

type LiveTurnProcess = {
  pid: number;
  processGroupId: number;
  processStartIdentity: string;
};

/** Mirrors readLinuxProcessIdentity in src/manager/acpx.ts. */
async function readProcIdentity(pid: number): Promise<LiveTurnProcess> {
  const raw = await readFile(`/proc/${pid}/stat`, "utf8");
  const commandEnd = raw.lastIndexOf(")");
  const fields = raw.slice(commandEnd + 1).trim().split(/\s+/u);
  const processGroupId = Number.parseInt(fields[2] ?? "", 10);
  const startTicks = fields[19];
  if (!Number.isFinite(processGroupId) || startTicks == null) {
    throw new Error(`Unable to read process identity for pid ${pid}.`);
  }
  return {
    pid,
    processGroupId,
    processStartIdentity: `${pid}:${startTicks}`
  };
}

function baseSeededSession(name: string, workspaceDir: string): SessionInfo {
  return {
    name,
    agent: "claude",
    directory: workspaceDir,
    state: "idle",
    createdAt: T_CREATED,
    lastActivity: T_LAST_ACTIVITY,
    permissionMode: "approve-reads",
    warnings: [],
    transcript: [
      { role: "user", text: `Task for ${name} scenario.`, createdAt: T_USER },
      { role: "assistant", text: `Answer for ${name} scenario.`, createdAt: T_ASSISTANT }
    ]
  };
}

function buildRestartScenarioSessions(
  workspaceDir: string,
  liveTurn: LiveTurnProcess
): Record<"running" | "orphaned" | "legacy-no-turn", SessionInfo> {
  return {
    running: {
      ...baseSeededSession("running", workspaceDir),
      state: "running",
      transcript: [
        { role: "user", text: "Task for running scenario.", createdAt: T_USER },
        { role: "assistant", text: "Answer for running scenario.", createdAt: T_ASSISTANT }
      ],
      activeTurn: {
        id: "turn-running-1",
        state: "running",
        startedAt: T_TURN_STARTED,
        updatedAt: T_TURN_OUTPUT,
        pid: liveTurn.pid,
        processGroupId: liveTurn.processGroupId,
        processStartIdentity: liveTurn.processStartIdentity,
        lastOutputAt: T_TURN_OUTPUT,
        outputChars: 42
      }
    },
    orphaned: {
      ...baseSeededSession("orphaned", workspaceDir),
      state: "running",
      activeTurn: {
        id: "turn-orphaned-1",
        state: "running",
        startedAt: T_TURN_STARTED,
        updatedAt: T_TURN_OUTPUT,
        pid: DEAD_PID,
        processGroupId: DEAD_PID,
        processStartIdentity: `${DEAD_PID}:1`,
        lastOutputAt: T_TURN_OUTPUT,
        outputChars: 7
      }
    },
    "legacy-no-turn": {
      ...baseSeededSession("legacy-no-turn", workspaceDir),
      state: "running"
    }
  };
}

function normalizedTerminalTurn(name: string, activeTurn: ActiveTurnMetadata): ActiveTurnMetadata {
  const {
    pid: _pid,
    processGroupId: _processGroupId,
    processStartIdentity: _processStartIdentity,
    ...stable
  } = activeTurn;
  return {
    ...stable,
    id: `turn-${name}-1`,
    startedAt: T_TURN_STARTED,
    updatedAt: T_TURN_OUTPUT,
    ...(activeTurn.completedAt != null ? { completedAt: T_TURN_OUTPUT } : {}),
    ...(activeTurn.lastOutputAt != null ? { lastOutputAt: T_TURN_OUTPUT } : {})
  };
}

async function normalizeRealScenario(store: Awaited<ReturnType<typeof createStoreAndRouter>>["store"], name: string): Promise<void> {
  const normalize = (current: SessionInfo): SessionInfo => ({
      ...current,
      createdAt: T_CREATED,
      lastActivity: T_LAST_ACTIVITY,
      transcript: current.transcript.map((entry) => ({
        ...entry,
        createdAt: entry.role === "user" ? T_USER : T_ASSISTANT,
        ...(entry.turnId != null ? { turnId: `turn-${name}-1` } : {})
      })),
      ...(current.activeTurn != null
        ? { activeTurn: normalizedTerminalTurn(name, current.activeTurn) }
        : {})
    });
  const epoch = store.getActiveQuiescenceEpoch(name);
  if (epoch != null) {
    await store.patchQuiescedSession(name, epoch, normalize);
    return;
  }
  await store.patchSession(name, (current) => {
    if (current == null) {
      throw new Error(`Missing generated scenario ${name}.`);
    }
    return normalize(current);
  });
}

async function generateRealScenarios(params: {
  dataDir: string;
  workspaceDir: string;
  acpxCommand: string;
}): Promise<void> {
  const { store, outputRouter } = await createStoreAndRouter(params.dataDir);
  const manager = new AcpxSessionManager({
    config: makeConfig({ acpxCommand: params.acpxCommand, maxSessions: 20 }),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    store,
    outputRouter
  });
  try {
    await manager.start({
      agent: "claude",
      name: "idle",
      directory: params.workspaceDir,
      task: "Successful idle fixture.",
      contextFiles: []
    });
    await manager.start({
      agent: "claude",
      name: "plan",
      directory: params.workspaceDir,
      task: "EXIT_PLAN_MODE",
      interactionMode: "plan",
      contextFiles: []
    });
    await manager.start({
      agent: "claude",
      name: "waiting-input",
      directory: params.workspaceDir,
      task: "ASK_USER",
      contextFiles: []
    });
    await manager.start({
      agent: "claude",
      name: "lost-stream",
      directory: params.workspaceDir,
      task: "Successful turn whose client stream was lost.",
      contextFiles: []
    });
    await manager.start({
      agent: "claude",
      name: "failed",
      directory: params.workspaceDir,
      task: "FAIL_TURN",
      contextFiles: []
    });
    await manager.start({
      agent: "claude",
      name: "quiesced",
      directory: params.workspaceDir,
      task: "Prime the quiesced fixture.",
      contextFiles: []
    });
    await manager.quiesce({ name: "quiesced" });
    for (const name of ["idle", "plan", "waiting-input", "lost-stream", "failed", "quiesced"]) {
      await normalizeRealScenario(store, name);
    }
  } finally {
    await store.close();
  }
}

function sanitizeBody(
  body: string,
  workspaceDir: string,
  liveTurn: LiveTurnProcess
): unknown {
  const processGroupMarker = `__PUPPENCLAW_PROCESS_GROUP_${liveTurn.processGroupId}__`;
  const sanitized = body
    .replaceAll(liveTurn.processStartIdentity, FIXED_PROCESS_START_IDENTITY)
    .replace(
      new RegExp(`\\b${liveTurn.processGroupId}\\b`, "gu"),
      processGroupMarker
    )
    .replace(new RegExp(`\\b${liveTurn.pid}\\b`, "gu"), String(FIXED_PID))
    .replaceAll(processGroupMarker, String(FIXED_PROCESS_GROUP_ID))
    .replaceAll(workspaceDir, FIXED_WORKSPACE)
    .replace(
      /(\\?"completedAt\\?":\s*\\?")[^"\\]+(\\?")/gu,
      `$1${T_TURN_OUTPUT}$2`
    )
    .replace(/(\\?"detectedAt\\?":\s*\\?")[^"\\]+(\\?")/gu, `$1${T_LAST_ACTIVITY}$2`)
    .replace(/(\\?"ageMs\\?":\s*)\d+/gu, `$1${FIXED_AGE_MS}`)
    .replace(/(\\?"outputAgeMs\\?":\s*)\d+/gu, `$1${FIXED_OUTPUT_AGE_MS}`)
    .replace(/("bootId":\s*")[^"]+(")/gu, `$1${FIXED_BOOT_ID}$2`)
    .replace(/("spoolId":\s*")[^"]+(")/gu, `$1${FIXED_SPOOL_ID}$2`);
  return JSON.parse(sanitized);
}

export async function generateContractFixtures(): Promise<
  Record<ContractScenario, ContractCapture>
> {
  if (process.platform !== "linux") {
    throw new Error("Contract fixture generation requires Linux process identity probing.");
  }
  const rootDir = await mkdtemp(join(tmpdir(), "puppenclaw-contract-"));
  const workspaceDir = join(rootDir, "workspace");
  const dataDir = join(rootDir, "daemon");
  const liveChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    stdio: "ignore",
    detached: true
  });
  try {
    if (liveChild.pid == null) {
      throw new Error("Unable to spawn the live turn placeholder process.");
    }
    const liveTurn = await readProcIdentity(liveChild.pid);
    const acpxCommand = await resolveFakeAcpxCommand();
    await mkdir(workspaceDir, { recursive: true });
    await generateRealScenarios({ dataDir, workspaceDir, acpxCommand });
    const restartScenarios = buildRestartScenarioSessions(workspaceDir, liveTurn);
    const restartStore = (await createStoreAndRouter(dataDir)).store;
    try {
      for (const session of Object.values(restartScenarios)) {
        await restartStore.upsertSession(session);
      }
    } finally {
      await restartStore.close();
    }

    // Preserve a live runtime only where the scenario calls for one. The real
    // start/send calls above create these markers through the fake ACP adapter.
    const fakeStateDir = join(workspaceDir, ".fake-acpx-state");
    await mkdir(fakeStateDir, { recursive: true });
    await writeFile(join(fakeStateDir, "running.session"), "alive\nclaude\n", "utf8");
    await rm(join(fakeStateDir, "failed.session"), { force: true });

    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand, maxSessions: 20 }),
      dataDir,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      }
    });
    try {
      const captures = {} as Record<ContractScenario, ContractCapture>;
      for (const scenario of CONTRACT_SCENARIOS) {
        const statusResponse = await app.inject({
          method: "GET",
          url: `/session/${scenario}`
        });
        const outputResponse = await app.inject({
          method: "GET",
          url: `/session/${scenario}/output`
        });
        const summaryResponse = await app.inject({
          method: "GET",
          url: `/session/${scenario}?view=summary`
        });
        if (
          statusResponse.statusCode !== 200 ||
          outputResponse.statusCode !== 200 ||
          summaryResponse.statusCode !== 200
        ) {
          throw new Error(
            `Scenario ${scenario} returned HTTP ${statusResponse.statusCode}/${outputResponse.statusCode}/${summaryResponse.statusCode}.`
          );
        }
        captures[scenario] = {
          status: sanitizeBody(statusResponse.body, workspaceDir, liveTurn),
          output: sanitizeBody(outputResponse.body, workspaceDir, liveTurn),
          summary: sanitizeBody(summaryResponse.body, workspaceDir, liveTurn)
        };
      }
      return captures;
    } finally {
      await app.close();
    }
  } finally {
    liveChild.kill("SIGKILL");
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const fixtures = await generateContractFixtures();
  await mkdir(CONTRACT_FIXTURES_DIR, { recursive: true });
  for (const scenario of CONTRACT_SCENARIOS) {
    const capture = fixtures[scenario];
    await writeFile(
      join(CONTRACT_FIXTURES_DIR, `${scenario}.status.json`),
      `${JSON.stringify(capture.status, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      join(CONTRACT_FIXTURES_DIR, `${scenario}.output.json`),
      `${JSON.stringify(capture.output, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      join(CONTRACT_FIXTURES_DIR, `${scenario}.summary.json`),
      `${JSON.stringify(capture.summary, null, 2)}\n`,
      "utf8"
    );
    console.info(`Wrote ${scenario}.status.json, ${scenario}.output.json and ${scenario}.summary.json`);
  }
}

if (
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
