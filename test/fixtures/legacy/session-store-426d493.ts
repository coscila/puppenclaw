// Verbatim copy of src/shared/store.ts at 426d493 (the session store that loads state.json). Only the import paths
// changed: the schemas resolve to their 426d493 copy beside this file, errors, types (types only) and utils to the
// current modules. The rollback tests open state written by later code with this exact code path.
import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import {
  advancedOrchestrationZod,
  agentKindZod,
  effortLevelZod,
  exposureModeZod,
  modelProviderConfigZod,
  permissionModeZod,
  planningProfileZod,
  REMOTE_CONTROL_VERBS,
  remoteVerbZod,
  SESSION_STORE_VERSION
} from "./schema-426d493.js";
import { PuppenclawError } from "../../../src/shared/errors.js";
import type {
  ExposureRecord,
  OwnerCleanupLifecycleState,
  OwnerCleanupReservation,
  SessionInfo,
  SessionQuiescenceReservation,
  StateRecoveryStatus,
  StoredState,
  TurnRequestErrorOutcome,
  TurnRequestReceipt,
  TurnRequestSuccessOutcome
} from "../../../src/shared/types.js";
import {
  ensureDir,
  nowIso,
  quarantineFile,
  redactSensitiveText,
  writeJsonFileAtomic
} from "../../../src/shared/utils.js";

const OWNER_LEASE_VERSION = 1 as const;
const OWNER_LEASE_FILE = ".state-owner.json";
/**
 * Identity of the persisted in-flight state ("spool"). It changes whenever the
 * state is replaced instead of continued: a fresh data directory, a recovery
 * reset, or state that could not be loaded. Consumers treat a new spoolId as
 * the loss of every turn the previous spool held.
 */
const SPOOL_FILE = "spool.json";
/**
 * Captured at load so tests that fake timers cannot stall the group commit.
 * One macrotask lets every mutation issued in the same event-loop turn (and its
 * promise continuations) join the batch.
 */
const nextMacrotask: (callback: () => void) => unknown = globalThis.setImmediate;

type PendingMutation = {
  mutator: (state: StoredState) => unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export type SessionStorePersistenceStats = {
  /** state.json writes. */
  writes: number;
  /** Mutations committed (successfully or not). */
  mutations: number;
  /** Commit rounds; a round with more than one mutation is a group commit. */
  batches: number;
  /** Group commits that fell back to per-mutation writes. */
  fallbacks: number;
  largestBatch: number;
};
const spoolRecordZod = z
  .object({
    version: z.literal(1),
    spoolId: z.string().uuid(),
    createdAt: z.string().min(1)
  })
  .strict();
/** Full terminal outcomes retained per logical session. Older identities become tombstones. */
export const MAX_TURN_REQUEST_OUTCOMES_PER_SESSION = 64;
export const MAX_TURN_REQUEST_IDENTITIES_PER_SESSION = 4_096;
export const MAX_TURN_REPLAY_OUTPUT_CHARS = 200_000;
const persistedTimestampZod = z.string().min(1).refine(
  (value) => Number.isFinite(Date.parse(value)),
  "Expected a parseable timestamp."
);

const transcriptEntryZod = z
  .object({
    role: z.enum(["system", "user", "assistant", "status"]),
    text: z.string(),
    createdAt: persistedTimestampZod,
    turnId: z.string().min(1).optional()
  })
  .strict();

const activeTurnZod = z
  .object({
    id: z.string().min(1),
    turnKey: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/u).optional(),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    state: z.enum(["running", "completed", "failed", "stopped", "orphaned"]),
    startedAt: persistedTimestampZod,
    updatedAt: persistedTimestampZod,
    completedAt: persistedTimestampZod.optional(),
    pid: z.number().int().positive().optional(),
    processGroupId: z.number().int().positive().optional(),
    processStartIdentity: z.string().min(1).optional(),
    lastOutputAt: persistedTimestampZod.optional(),
    outputChars: z.number().int().nonnegative(),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
    error: z.string().optional(),
    failureCode: z.string().min(1).optional(),
    retryable: z.boolean().optional()
  })
  .strict()
  .superRefine((turn, context) => {
    if ((turn.turnKey == null) !== (turn.requestFingerprint == null)) {
      context.addIssue({
        code: "custom",
        path: [turn.turnKey == null ? "turnKey" : "requestFingerprint"],
        message: "A keyed active turn requires both its turn key and request fingerprint."
      });
    }
    const startedAt = Date.parse(turn.startedAt);
    const updatedAt = Date.parse(turn.updatedAt);
    if (updatedAt < startedAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "Active-turn update time cannot precede its start time."
      });
    }
    if (turn.lastOutputAt != null && Date.parse(turn.lastOutputAt) < startedAt) {
      context.addIssue({
        code: "custom",
        path: ["lastOutputAt"],
        message: "Active-turn output time cannot precede its start time."
      });
    }
    if (turn.state === "running" && turn.completedAt != null) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "A running active turn cannot already have a completion time."
      });
    }
    if (turn.state !== "running" && turn.completedAt == null) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "A terminal active turn requires a completion time."
      });
    }
    if (turn.completedAt != null && Date.parse(turn.completedAt) < startedAt) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Active-turn completion time cannot precede its start time."
      });
    }
    if (turn.processGroupId != null && turn.pid == null) {
      context.addIssue({
        code: "custom",
        path: ["processGroupId"],
        message: "An active-turn process group requires its owning PID."
      });
    }
    if (turn.processStartIdentity != null && turn.pid == null) {
      context.addIssue({
        code: "custom",
        path: ["processStartIdentity"],
        message: "An active-turn process identity requires its PID."
      });
    }
  });

const recoveryFenceZod = z
  .object({
    reason: z.enum(["restart-survivor", "unverified-process", "missing-turn-metadata"]),
    detectedAt: persistedTimestampZod,
    pid: z.number().int().positive().optional(),
    processGroupId: z.number().int().positive().optional(),
    processStartIdentity: z.string().min(1).optional()
  })
  .strict()
  .superRefine((fence, context) => {
    if (fence.processGroupId != null && fence.pid == null) {
      context.addIssue({
        code: "custom",
        path: ["processGroupId"],
        message: "A recovery-fence process group requires its owning PID."
      });
    }
    if (fence.processStartIdentity != null && fence.pid == null) {
      context.addIssue({
        code: "custom",
        path: ["processStartIdentity"],
        message: "A recovery-fence process identity requires its PID."
      });
    }
  });

const tokenUsageZod = z
  .object({
    used: z.number().finite().nonnegative().optional(),
    size: z.number().finite().nonnegative().optional(),
    input: z.number().finite().nonnegative().optional(),
    output: z.number().finite().nonnegative().optional(),
    cacheRead: z.number().finite().nonnegative().optional(),
    cacheWrite: z.number().finite().nonnegative().optional(),
    cached: z.number().finite().nonnegative().optional()
  })
  .strict();

const conversationScopeZod = z
  .object({
    channel: z.string(),
    accountId: z.string(),
    conversationId: z.string(),
    parentConversationId: z.string().optional(),
    threadId: z.union([z.string(), z.number()]).optional()
  })
  .strict();

const sessionSourceZod = z
  .object({
    kind: z.enum(["tool", "command", "daemon"]),
    channel: z.string().optional(),
    requesterSenderId: z.string().optional(),
    bindingId: z.string().optional()
  })
  .strict();

const sessionInfoZod = z
  .object({
    name: z.string().min(1),
    agent: agentKindZod,
    directory: z.string().min(1),
    state: z.enum(["idle", "running", "waiting_input", "suspended", "completed", "failed", "stopped"]),
    createdAt: persistedTimestampZod,
    lastActivity: persistedTimestampZod,
    focusedUntil: persistedTimestampZod.optional(),
    permissionMode: permissionModeZod,
    effort: effortLevelZod.optional(),
    effectiveEffort: effortLevelZod.optional(),
    runtimeEffort: effortLevelZod.optional(),
    reasoningProfile: z.enum(["claude", "codex", "glm-5.2", "qwen-3.6", "qwen-3.8"]).optional(),
    planningProfile: planningProfileZod.optional(),
    model: z.string().min(1).optional(),
    modelProviderId: z.string().min(1).optional(),
    modelProvider: modelProviderConfigZod.optional(),
    orchestration: advancedOrchestrationZod.optional(),
    skills: z.array(z.string().min(1)).optional(),
    tokenUsage: tokenUsageZod.optional(),
    pendingQuestion: z.string().optional(),
    lastError: z.string().optional(),
    failureCode: z.string().min(1).optional(),
    retryable: z.boolean().optional(),
    warnings: z.array(z.string()),
    transcript: z.array(transcriptEntryZod),
    handle: z
      .object({
        runtimeSessionName: z.string().min(1),
        cwd: z.string().min(1),
        agent: agentKindZod,
        mode: z.literal("persistent")
      })
      .strict()
      .optional(),
    lastStopReason: z.string().optional(),
    activeTurn: activeTurnZod.optional(),
    recoveryFence: recoveryFenceZod.optional(),
    source: sessionSourceZod.optional(),
    origin: conversationScopeZod.optional()
  })
  .strict();

const replaySessionZod = z
  .object({
    name: z.string().min(1),
    state: z.enum(["idle", "running", "waiting_input", "suspended", "completed", "failed", "stopped"]),
    lastActivity: persistedTimestampZod,
    pendingQuestion: z.string().optional(),
    lastError: z.string().optional(),
    failureCode: z.string().min(1).optional(),
    retryable: z.boolean().optional(),
    activeTurn: activeTurnZod.optional(),
    tokenUsage: tokenUsageZod.optional()
  })
  .strict();

const turnSignalsZod = z
  .object({
    nativeMode: z.string().optional(),
    plan: z
      .object({
        source: z.enum(["acp", "claude-tool"]),
        entries: z
          .array(
            z
              .object({
                content: z.string(),
                status: z.string().optional(),
                priority: z.string().optional()
              })
              .strict()
          )
          .optional()
      })
      .strict()
      .optional(),
    inputRequest: z
      .object({
        source: z.literal("claude-tool"),
        toolName: z.literal("AskUserQuestion"),
        text: z.string().optional()
      })
      .strict()
      .optional(),
    stopReason: z.string().optional()
  })
  .strict();

const contextFileEntryZod = z
  .object({
    path: z.string(),
    resolvedPath: z.string(),
    bytes: z.number().int().nonnegative(),
    truncated: z.boolean()
  })
  .strict();

const installedSkillReceiptZod = z
  .object({
    name: z.string().min(1),
    sourcePath: z.string().min(1),
    targetPath: z.string().min(1)
  })
  .strict();

const safeErrorDetailsZod = z.record(
  z.string(),
  z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
);

const turnRequestOutcomeZod = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("success"),
      version: z.literal(1),
      summary: z.string().min(1),
      session: replaySessionZod,
      output: z.string().max(MAX_TURN_REPLAY_OUTPUT_CHARS),
      outputRole: z.enum(["assistant", "status"]),
      failureCode: z.string().min(1).optional(),
      retryable: z.boolean().optional(),
      turnSignals: turnSignalsZod.optional(),
      contextFiles: z.array(contextFileEntryZod.omit({ resolvedPath: true }).strict()),
      skills: z.array(installedSkillReceiptZod.pick({ name: true }).strict()).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      version: z.literal(1),
      code: z.string().min(1),
      message: z.string(),
      retryable: z.boolean().optional(),
      details: safeErrorDetailsZod.optional(),
      session: replaySessionZod.optional()
    })
    .strict()
]);

const turnRequestReceiptZod = z
  .object({
    sessionName: z.string().min(1),
    turnKey: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/u),
    operation: z.enum(["start", "send"]),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    state: z.enum(["running", "settled", "tombstone"]),
    acceptedAt: persistedTimestampZod,
    updatedAt: persistedTimestampZod,
    completedAt: persistedTimestampZod.optional(),
    activeTurnId: z.string().min(1).optional(),
    outcome: turnRequestOutcomeZod.optional()
  })
  .strict()
  .superRefine((receipt, context) => {
    if (Date.parse(receipt.updatedAt) < Date.parse(receipt.acceptedAt)) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "Turn-request update time cannot precede acceptance."
      });
    }
    if (receipt.state === "running" && (receipt.completedAt != null || receipt.outcome != null)) {
      context.addIssue({
        code: "custom",
        path: [receipt.completedAt != null ? "completedAt" : "outcome"],
        message: "An unsettled turn request cannot already have a terminal outcome."
      });
    }
    if (receipt.state === "settled" && (receipt.completedAt == null || receipt.outcome == null)) {
      context.addIssue({
        code: "custom",
        path: [receipt.completedAt == null ? "completedAt" : "outcome"],
        message: "A settled turn request requires a completion time and outcome."
      });
    }
    if (
      receipt.state === "tombstone" &&
      (receipt.completedAt == null || receipt.outcome != null)
    ) {
      context.addIssue({
        code: "custom",
        path: [receipt.completedAt == null ? "completedAt" : "outcome"],
        message: "A turn-request tombstone requires a completion time and no replay payload."
      });
    }
    if (
      receipt.completedAt != null &&
      Date.parse(receipt.completedAt) < Date.parse(receipt.acceptedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Turn-request completion time cannot precede acceptance."
      });
    }
  });

const exposureRecordZod = z
  .object({
    bindingId: z.string().min(1),
    conversation: conversationScopeZod,
    allowPurePipe: z.boolean(),
    allowedAgents: z.array(agentKindZod),
    mode: exposureModeZod,
    allowedVerbs: z.array(remoteVerbZod),
    allowedProjectRoots: z.array(z.string()),
    updatedAt: persistedTimestampZod
  })
  .strict();

const quiescenceReservationZod = z
  .object({
    name: z.string().min(1),
    epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    purpose: z.enum(["external", "purge"]),
    updatedAt: persistedTimestampZod
  })
  .strict();

const ownerKeyZod = z.string().min(16).max(128).regex(/^[a-zA-Z0-9._:-]+$/u);

const ownerCleanupReservationZod = z
  .object({
    epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    operationKey: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/u),
    state: z.enum(["quiesced", "purging", "purged"]),
    updatedAt: persistedTimestampZod
  })
  .strict();

const storedStateZod = z
  .object({
    version: z.literal(SESSION_STORE_VERSION),
    sessions: z.record(z.string().min(1), sessionInfoZod),
    turnRequests: z.record(
      z.string().min(1),
      z.record(z.string().min(1), turnRequestReceiptZod)
    ),
    turnGenerations: z.record(
      z.string().min(1),
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    ),
    exposures: z.record(z.string().min(1), exposureRecordZod),
    quiescence: z
      .object({
        lastEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        active: z.record(z.string().min(1), quiescenceReservationZod),
        latestByName: z.record(
          z.string().min(1),
          z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
        )
      })
      .strict(),
    sessionOwners: z.record(z.string().min(1), ownerKeyZod).default({}),
    ownerCleanup: z
      .object({
        lastEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        scopes: z.record(ownerKeyZod, ownerCleanupReservationZod)
      })
      .strict()
      .default({ lastEpoch: 0, scopes: {} })
  })
  .strict()
  .superRefine((state, context) => {
    for (const [name, session] of Object.entries(state.sessions)) {
      if (session.name !== name) {
        context.addIssue({
          code: "custom",
          path: ["sessions", name, "name"],
          message: `Session map key ${JSON.stringify(name)} does not match embedded name ${JSON.stringify(session.name)}.`
        });
      }
      if (
        session.handle != null &&
        (session.handle.runtimeSessionName !== session.name ||
          session.handle.agent !== session.agent)
      ) {
        context.addIssue({
          code: "custom",
          path: ["sessions", name, "handle"],
          message: "Session runtime handle identity does not match its owning session."
        });
      }
    }

    for (const [sessionName, receipts] of Object.entries(state.turnRequests)) {
      if (
        Object.values(receipts).filter((receipt) => receipt.state === "settled").length >
        MAX_TURN_REQUEST_OUTCOMES_PER_SESSION
      ) {
        context.addIssue({
          code: "custom",
          path: ["turnRequests", sessionName],
          message: `Turn-request replay retention exceeds ${MAX_TURN_REQUEST_OUTCOMES_PER_SESSION} outcomes.`
        });
      }
      if (Object.keys(receipts).length > MAX_TURN_REQUEST_IDENTITIES_PER_SESSION) {
        context.addIssue({
          code: "custom",
          path: ["turnRequests", sessionName],
          message: `Turn-request identity retention exceeds ${MAX_TURN_REQUEST_IDENTITIES_PER_SESSION} keys.`
        });
      }
      let runningReceipts = 0;
      for (const [turnKey, receipt] of Object.entries(receipts)) {
        if (receipt.sessionName !== sessionName || receipt.turnKey !== turnKey) {
          context.addIssue({
            code: "custom",
            path: ["turnRequests", sessionName, turnKey],
            message: "Turn-request map identity does not match its embedded session and key."
          });
        }
        if (receipt.state === "running") {
          runningReceipts += 1;
          if (receipt.activeTurnId != null) {
            const linkedTurn = state.sessions[sessionName]?.activeTurn;
            if (
              linkedTurn == null ||
              linkedTurn.state !== "running" ||
              linkedTurn.id !== receipt.activeTurnId ||
              linkedTurn.turnKey !== receipt.turnKey ||
              linkedTurn.requestFingerprint !== receipt.requestFingerprint
            ) {
              context.addIssue({
                code: "custom",
                path: ["turnRequests", sessionName, turnKey, "activeTurnId"],
                message: "A linked running turn request requires its exact running session active turn."
              });
            }
          }
        }
        if (receipt.state === "settled" && receipt.activeTurnId != null) {
          const activeTurn = state.sessions[sessionName]?.activeTurn;
          if (activeTurn?.id === receipt.activeTurnId && activeTurn.state === "running") {
            context.addIssue({
              code: "custom",
              path: ["turnRequests", sessionName, turnKey, "state"],
              message: "A settled turn request cannot point at a running active turn."
            });
          }
        }
        if (
          receipt.outcome?.kind === "success" &&
          receipt.outcome.session.name !== sessionName
        ) {
          context.addIssue({
            code: "custom",
            path: ["turnRequests", sessionName, turnKey, "outcome", "session", "name"],
            message: "A replay outcome must belong to its receipt session."
          });
        }
        if (receipt.outcome?.kind === "success") {
          const replayTurn = receipt.outcome.session.activeTurn;
          if (
            receipt.activeTurnId == null ||
            receipt.outcome.session.state === "running" ||
            replayTurn == null ||
            replayTurn.state === "running" ||
            replayTurn.id !== receipt.activeTurnId ||
            replayTurn.turnKey !== receipt.turnKey ||
            replayTurn.requestFingerprint !== receipt.requestFingerprint
          ) {
            context.addIssue({
              code: "custom",
              path: ["turnRequests", sessionName, turnKey, "outcome", "session"],
              message: "A successful replay outcome must contain its matching terminal active turn."
            });
          }
        }
        if (receipt.outcome?.kind === "error" && receipt.activeTurnId != null) {
          const replayTurn = receipt.outcome.session?.activeTurn;
          if (
            replayTurn == null ||
            receipt.outcome.session?.state === "running" ||
            replayTurn.state === "running" ||
            replayTurn.id !== receipt.activeTurnId ||
            replayTurn.turnKey !== receipt.turnKey ||
            replayTurn.requestFingerprint !== receipt.requestFingerprint
          ) {
            context.addIssue({
              code: "custom",
              path: ["turnRequests", sessionName, turnKey, "outcome", "session"],
              message: "A replay error linked to an active turn requires its matching terminal snapshot."
            });
          }
        }
      }
      if (runningReceipts > 1) {
        context.addIssue({
          code: "custom",
          path: ["turnRequests", sessionName],
          message: "A session cannot have more than one active or ambiguous turn request."
        });
      }
    }

    for (const [sessionName, session] of Object.entries(state.sessions)) {
      const activeTurn = session.activeTurn;
      if (activeTurn?.turnKey == null || activeTurn.requestFingerprint == null) {
        continue;
      }
      const receipt = state.turnRequests[sessionName]?.[activeTurn.turnKey];
      if (
        receipt == null ||
        receipt.requestFingerprint !== activeTurn.requestFingerprint ||
        receipt.activeTurnId !== activeTurn.id ||
        (activeTurn.state === "running" && receipt.state !== "running")
      ) {
        context.addIssue({
          code: "custom",
          path: ["sessions", sessionName, "activeTurn"],
          message: "A keyed active turn must match its durable turn-request receipt."
        });
      }
    }

    for (const [bindingId, exposure] of Object.entries(state.exposures)) {
      if (exposure.bindingId !== bindingId) {
        context.addIssue({
          code: "custom",
          path: ["exposures", bindingId, "bindingId"],
          message: `Exposure map key ${JSON.stringify(bindingId)} does not match embedded binding id ${JSON.stringify(exposure.bindingId)}.`
        });
      }
    }

    for (const [name, reservation] of Object.entries(state.quiescence.active)) {
      if (reservation.name !== name) {
        context.addIssue({
          code: "custom",
          path: ["quiescence", "active", name, "name"],
          message: `Quiescence map key ${JSON.stringify(name)} does not match embedded name ${JSON.stringify(reservation.name)}.`
        });
      }
      if (reservation.epoch > state.quiescence.lastEpoch) {
        context.addIssue({
          code: "custom",
          path: ["quiescence", "active", name, "epoch"],
          message: "Active quiescence epoch exceeds the durable epoch high-water mark."
        });
      }
      const latestEpoch = state.quiescence.latestByName[name];
      if (reservation.purpose === "external" && latestEpoch !== reservation.epoch) {
        context.addIssue({
          code: "custom",
          path: ["quiescence", "latestByName", name],
          message: "An external quiescence fence must match the latest lifecycle epoch."
        });
      }
      if (
        reservation.purpose === "purge" &&
        latestEpoch != null &&
        latestEpoch >= reservation.epoch
      ) {
        context.addIssue({
          code: "custom",
          path: ["quiescence", "latestByName", name],
          message: "A transient purge fence must be newer than prior external lifecycle history."
        });
      }
    }

    for (const [name, epoch] of Object.entries(state.quiescence.latestByName)) {
      if (epoch > state.quiescence.lastEpoch) {
        context.addIssue({
          code: "custom",
          path: ["quiescence", "latestByName", name],
          message: "Latest lifecycle epoch exceeds the durable epoch high-water mark."
        });
      }
    }

    for (const [ownerKey, reservation] of Object.entries(state.ownerCleanup.scopes)) {
      if (reservation.epoch > state.ownerCleanup.lastEpoch) {
        context.addIssue({
          code: "custom",
          path: ["ownerCleanup", "scopes", ownerKey, "epoch"],
          message: "Owner-cleanup epoch exceeds the durable epoch high-water mark."
        });
      }
    }
  });

const ownerLeaseZod = z
  .object({
    version: z.literal(OWNER_LEASE_VERSION),
    ownerId: z.string().min(1),
    pid: z.number().int().positive(),
    processStartIdentity: z.string().min(1).optional(),
    acquiredAt: persistedTimestampZod
  })
  .strict();

type OwnerLease = z.infer<typeof ownerLeaseZod>;

function freshState(): StoredState {
  return {
    version: SESSION_STORE_VERSION,
    sessions: {},
    turnRequests: {},
    turnGenerations: {},
    exposures: {},
    quiescence: { lastEpoch: 0, active: {}, latestByName: {} },
    sessionOwners: {},
    ownerCleanup: { lastEpoch: 0, scopes: {} }
  };
}

export class SessionStore {
  private mutationTail: Promise<void> = Promise.resolve();
  private closed = false;
  private pendingMutations = 0;
  private readonly mutationQueue: PendingMutation[] = [];
  private flushScheduled = false;
  private readonly stats: SessionStorePersistenceStats = {
    writes: 0,
    mutations: 0,
    batches: 0,
    fallbacks: 0,
    largestBatch: 0
  };

  private constructor(
    readonly rootDir: string,
    private state: StoredState,
    private recovery: StateRecoveryStatus,
    private readonly ownerLease: OwnerLease,
    private spool: { id: string; persisted: boolean }
  ) {}

  static async open(rootDir: string): Promise<SessionStore> {
    const ownerLease = await acquireOwnerLease(rootDir);
    try {
      const loaded = await loadStoredState(join(rootDir, "state.json"));
      if (process.platform !== "win32") {
        await chmod(join(rootDir, "state.json"), 0o600).catch((error) => {
          if (!isNodeError(error, "ENOENT")) {
            throw error;
          }
        });
      }
      // Continued state keeps its spool identity. A fresh or unreadable state
      // starts a new spool; it is written with the first state write (fresh) or
      // the operator reset (recovery), so opening alone never adds files.
      let spool: { id: string; persisted: boolean } = { id: randomUUID(), persisted: false };
      if (loaded.origin === "loaded") {
        const existing = await readSpoolId(join(rootDir, SPOOL_FILE));
        spool =
          existing != null
            ? { id: existing, persisted: true }
            : { id: await writeSpoolRecord(join(rootDir, SPOOL_FILE), spool.id), persisted: true };
      }
      return new SessionStore(rootDir, loaded.state, loaded.recovery, ownerLease, spool);
    } catch (error) {
      await releaseOwnerLease(rootDir, ownerLease);
      throw error;
    }
  }

  /** Identity of the persisted in-flight state; see SPOOL_FILE. */
  get spoolId(): string {
    return this.spool.id;
  }

  /** Mutations accepted but not yet durably written (a backlog signal for health). */
  get pendingMutationCount(): number {
    return this.pendingMutations;
  }

  persistenceStats(): SessionStorePersistenceStats {
    return { ...this.stats };
  }

  get statePath(): string {
    return join(this.rootDir, "state.json");
  }

  get ownerLeasePath(): string {
    return join(this.rootDir, OWNER_LEASE_FILE);
  }

  getRecoveryStatus(): StateRecoveryStatus {
    return structuredClone(this.recovery);
  }

  async resetRecovery(): Promise<StateRecoveryStatus> {
    if (!this.recovery.required) {
      return { required: false };
    }
    await this.enqueueMutation(async () => {
      const nextState = freshState();
      const spoolId = await writeSpoolRecord(join(this.rootDir, SPOOL_FILE), randomUUID());
      await writeJsonFileAtomic(this.statePath, nextState, { mode: 0o600 });
      this.spool = { id: spoolId, persisted: true };
      this.state = nextState;
      this.recovery = { required: false };
    });
    return { required: false };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.mutationTail.catch(() => undefined);
    await releaseOwnerLease(this.rootDir, this.ownerLease);
  }

  listSessions(): SessionInfo[] {
    return Object.values(this.state.sessions).sort((left, right) =>
      right.lastActivity.localeCompare(left.lastActivity)
    );
  }

  listSessionsByOwner(ownerKey: string): SessionInfo[] {
    return this.listSessions().filter((session) => this.state.sessionOwners[session.name] === ownerKey);
  }

  getSessionOwner(name: string): string | null {
    return this.state.sessionOwners[name] ?? null;
  }

  getSession(name: string): SessionInfo | null {
    return this.state.sessions[name] ?? null;
  }

  getTurnRequest(sessionName: string, turnKey: string): TurnRequestReceipt | null {
    return this.state.turnRequests[sessionName]?.[turnKey] ?? null;
  }

  getTurnRequests(sessionName: string): Record<string, TurnRequestReceipt> {
    return this.state.turnRequests[sessionName] ?? {};
  }

  listRunningTurnRequests(): TurnRequestReceipt[] {
    return Object.values(this.state.turnRequests)
      .flatMap((receipts) => Object.values(receipts))
      .filter((receipt) => receipt.state === "running");
  }

  getTurnGeneration(sessionName: string): number {
    return this.state.turnGenerations[sessionName] ?? 0;
  }

  async claimTurnRequest(params: {
    sessionName: string;
    turnKey: string;
    operation: "start" | "send";
    requestFingerprint: string;
  }): Promise<TurnRequestReceipt> {
    return await this.mutate((state) => {
      assertSessionMutable(state, params.sessionName);
      const receipts = (state.turnRequests[params.sessionName] ??= {});
      if (receipts[params.turnKey] != null) {
        throw new PuppenclawError(
          "TURN_KEY_ALREADY_CLAIMED",
          `Turn key ${params.turnKey} is already claimed for session ${params.sessionName}.`
        );
      }
      const unsettled = Object.values(receipts).find((receipt) => receipt.state === "running");
      if (unsettled != null) {
        throw new PuppenclawError(
          "TURN_REPLAY_UNAVAILABLE",
          `Session ${params.sessionName} has active or ambiguous turn key ${unsettled.turnKey}; refusing another dispatch.`,
          { name: params.sessionName, turnKey: unsettled.turnKey }
        );
      }
      if (Object.keys(receipts).length >= MAX_TURN_REQUEST_IDENTITIES_PER_SESSION) {
        throw new PuppenclawError(
          "TURN_RECEIPT_CAPACITY_REACHED",
          `Session ${params.sessionName} has reached its durable ${MAX_TURN_REQUEST_IDENTITIES_PER_SESSION}-key identity limit; explicitly purge it before accepting another key.`,
          {
            name: params.sessionName,
            maximum: MAX_TURN_REQUEST_IDENTITIES_PER_SESSION
          }
        );
      }
      compactOldestReplayOutcome(receipts);
      const acceptedAt = nowIso();
      const receipt: TurnRequestReceipt = {
        sessionName: params.sessionName,
        turnKey: params.turnKey,
        operation: params.operation,
        requestFingerprint: params.requestFingerprint,
        state: "running",
        acceptedAt,
        updatedAt: acceptedAt
      };
      receipts[params.turnKey] = receipt;
      return receipt;
    });
  }

  async patchSessionAndLinkTurnRequest(
    sessionName: string,
    turnKey: string,
    requestFingerprint: string,
    patch: (current: SessionInfo | null) => SessionInfo
  ): Promise<SessionInfo> {
    return await this.mutate((state) => {
      assertSessionMutable(state, sessionName);
      const receipt = requireRunningTurnRequest(
        state,
        sessionName,
        turnKey,
        requestFingerprint
      );
      const next = patch(state.sessions[sessionName] ?? null);
      const activeTurn = next.activeTurn;
      if (
        activeTurn?.turnKey !== turnKey ||
        activeTurn.requestFingerprint !== requestFingerprint
      ) {
        throw new PuppenclawError(
          "INVALID_STATE_MUTATION",
          `Active turn for ${sessionName} does not link to turn key ${turnKey}.`
        );
      }
      state.sessions[sessionName] = next;
      receipt.activeTurnId = activeTurn.id;
      receipt.updatedAt = nowIso();
      return next;
    });
  }

  async patchSessionAndSettleTurnRequest(
    sessionName: string,
    turnKey: string,
    requestFingerprint: string,
    patch: (current: SessionInfo | null) => SessionInfo,
    outcome:
      | Omit<TurnRequestSuccessOutcome, "session">
      | TurnRequestErrorOutcome
  ): Promise<SessionInfo> {
    return await this.mutate((state) => {
      assertSessionMutable(state, sessionName);
      const receipt = requireRunningTurnRequest(
        state,
        sessionName,
        turnKey,
        requestFingerprint
      );
      const next = patch(state.sessions[sessionName] ?? null);
      state.sessions[sessionName] = next;
      const completedAt = nowIso();
      receipt.state = "settled";
      receipt.updatedAt = completedAt;
      receipt.completedAt = completedAt;
      receipt.outcome =
        outcome.kind === "success"
          ? compactSuccessOutcome(outcome, next)
          : { ...outcome, ...(receipt.activeTurnId != null ? { session: replaySessionSnapshot(next) } : {}) };
      return next;
    });
  }

  async settleTurnRequestError(
    sessionName: string,
    turnKey: string,
    requestFingerprint: string,
    outcome: TurnRequestErrorOutcome
  ): Promise<TurnRequestReceipt> {
    return await this.mutate((state) => {
      const receipt = requireRunningTurnRequest(
        state,
        sessionName,
        turnKey,
        requestFingerprint
      );
      const completedAt = nowIso();
      receipt.state = "settled";
      receipt.updatedAt = completedAt;
      receipt.completedAt = completedAt;
      const session = state.sessions[sessionName];
      receipt.outcome = {
        ...outcome,
        ...(receipt.activeTurnId != null && session != null
          ? { session: replaySessionSnapshot(session) }
          : {})
      };
      return receipt;
    });
  }

  async settleTurnRequestDuringReconciliation(
    sessionName: string,
    turnKey: string,
    requestFingerprint: string,
    outcome: TurnRequestErrorOutcome,
    patch?: (current: SessionInfo) => SessionInfo
  ): Promise<TurnRequestReceipt> {
    return await this.mutate((state) => {
      const receipt = requireRunningTurnRequest(
        state,
        sessionName,
        turnKey,
        requestFingerprint
      );
      const current = state.sessions[sessionName];
      let next = current;
      if (current != null && patch != null) {
        next = patch(current);
        state.sessions[sessionName] = next;
      }
      const completedAt = nowIso();
      receipt.state = "settled";
      receipt.updatedAt = completedAt;
      receipt.completedAt = completedAt;
      receipt.outcome = {
        ...outcome,
        ...(receipt.activeTurnId != null && next != null
          ? { session: replaySessionSnapshot(next) }
          : {})
      };
      return receipt;
    });
  }

  async upsertSession(session: SessionInfo, ownerKey?: string): Promise<void> {
    await this.mutate((state) => {
      assertSessionMutable(state, session.name);
      const current = state.sessions[session.name];
      const currentOwner = state.sessionOwners[session.name];
      if (current == null) {
        if (currentOwner != null && currentOwner !== ownerKey) {
          throw new PuppenclawError(
            "SESSION_OWNER_CONFLICT",
            `Session ${session.name} belongs to a different account scope.`
          );
        }
        if (ownerKey != null && state.ownerCleanup.scopes[ownerKey] != null) {
          throw new PuppenclawError(
            "OWNER_SCOPE_QUIESCED",
            "This account scope is fenced from creating new sessions."
          );
        }
        if (ownerKey != null) {
          state.sessionOwners[session.name] = ownerKey;
        }
      } else if (ownerKey != null && currentOwner !== ownerKey) {
        throw new PuppenclawError(
          "SESSION_OWNER_CONFLICT",
          `Session ${session.name} belongs to a different account scope.`
        );
      }
      state.sessions[session.name] = session;
    });
  }

  async patchSession(
    name: string,
    patch: (current: SessionInfo | null) => SessionInfo | null
  ): Promise<SessionInfo | null> {
    return await this.mutate((state) => {
      assertSessionMutable(state, name);
      const next = patch(state.sessions[name] ?? null);
      if (next == null) {
        delete state.sessions[name];
      } else {
        state.sessions[name] = next;
      }
      return next;
    });
  }

  async patchQuiescedSession(
    name: string,
    epoch: number,
    patch: (current: SessionInfo) => SessionInfo
  ): Promise<SessionInfo | null> {
    return await this.mutate((state) => {
      const reservation = state.quiescence.active[name];
      if (reservation?.epoch !== epoch) {
        throw staleQuiescenceEpoch(
          name,
          epoch,
          reservation,
          state.quiescence.latestByName[name],
          state.quiescence.lastEpoch
        );
      }
      const current = state.sessions[name];
      if (current == null) {
        return null;
      }
      const next = patch(current);
      state.sessions[name] = next;
      return next;
    });
  }

  async removeSession(name: string): Promise<boolean> {
    return await this.mutate((state) => {
      const existed = name in state.sessions || name in state.turnRequests;
      delete state.sessions[name];
      // Explicit purge is the data-forgetting boundary. Its caller must first
      // prove that no keyed work can survive; only then are replay outcomes
      // removed with the session transcript they contain.
      delete state.turnRequests[name];
      const generation = state.turnGenerations[name] ?? 0;
      if (!Number.isSafeInteger(generation) || generation >= Number.MAX_SAFE_INTEGER) {
        throw new PuppenclawError(
          "TURN_GENERATION_EXHAUSTED",
          `Session ${name} cannot allocate another purge generation.`
        );
      }
      state.turnGenerations[name] = generation + 1;
      return existed;
    });
  }

  getExposure(bindingId: string): ExposureRecord | null {
    const exposure = this.state.exposures[bindingId];
    return exposure != null ? normalizeExposureRecord(exposure) : null;
  }

  listExposures(): ExposureRecord[] {
    return Object.values(this.state.exposures)
      .map((exposure) => normalizeExposureRecord(exposure))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async upsertExposure(exposure: ExposureRecord): Promise<void> {
    await this.mutate((state) => {
      state.exposures[exposure.bindingId] = normalizeExposureRecord({
        ...exposure,
        updatedAt: exposure.updatedAt || nowIso()
      });
    });
  }

  async removeExposure(bindingId: string): Promise<boolean> {
    return await this.mutate((state) => {
      if (!(bindingId in state.exposures)) {
        return false;
      }
      delete state.exposures[bindingId];
      return true;
    });
  }

  getQuiescence(name: string): SessionQuiescenceReservation | null {
    return this.state.quiescence.active[name] ?? null;
  }

  getOwnerCleanup(ownerKey: string): OwnerCleanupReservation | null {
    return this.state.ownerCleanup.scopes[ownerKey] ?? null;
  }

  async reserveOwnerCleanup(
    ownerKey: string,
    operationKey: string,
    sessionNames: string[] = []
  ): Promise<OwnerCleanupReservation> {
    return await this.mutate((state) => {
      const current = state.ownerCleanup.scopes[ownerKey];
      if (current != null) {
        if (current.operationKey !== operationKey) {
          throw new PuppenclawError(
            "OWNER_CLEANUP_CONFLICT",
            "A different cleanup operation already owns this account scope."
          );
        }
      }
      const authoritativeNames = [...new Set(sessionNames)];
      for (const name of authoritativeNames) {
        const claimedOwner = state.sessionOwners[name];
        if (claimedOwner != null && claimedOwner !== ownerKey) {
          throw new PuppenclawError(
            "SESSION_OWNER_CONFLICT",
            "An authoritative legacy session belongs to a different account scope."
          );
        }
        if (claimedOwner == null && state.sessions[name] == null) {
          throw new PuppenclawError(
            "OWNER_ADOPTION_UNPROVEN",
            "An authoritative legacy session is neither present nor durably owned by this account scope."
          );
        }
      }
      for (const name of authoritativeNames) {
        state.sessionOwners[name] = ownerKey;
      }
      if (current != null) {
        return current;
      }
      const lastEpoch = state.ownerCleanup.lastEpoch;
      if (!Number.isSafeInteger(lastEpoch) || lastEpoch >= Number.MAX_SAFE_INTEGER) {
        throw new PuppenclawError(
          "OWNER_CLEANUP_EPOCH_EXHAUSTED",
          "The account-cleanup lifecycle cannot allocate another epoch."
        );
      }
      const reservation: OwnerCleanupReservation = {
        epoch: lastEpoch + 1,
        operationKey,
        state: "quiesced",
        updatedAt: nowIso()
      };
      state.ownerCleanup.lastEpoch = reservation.epoch;
      state.ownerCleanup.scopes[ownerKey] = reservation;
      return reservation;
    });
  }

  async promoteOwnerCleanup(
    ownerKey: string,
    operationKey: string,
    nextState: OwnerCleanupLifecycleState
  ): Promise<OwnerCleanupReservation> {
    return await this.mutate((state) => {
      const current = state.ownerCleanup.scopes[ownerKey];
      if (current == null || current.operationKey !== operationKey) {
        throw new PuppenclawError(
          "OWNER_CLEANUP_CONFLICT",
          "This cleanup operation does not own the account scope."
        );
      }
      const order: Record<OwnerCleanupLifecycleState, number> = {
        quiesced: 0,
        purging: 1,
        purged: 2
      };
      if (order[nextState] < order[current.state]) {
        return current;
      }
      const next: OwnerCleanupReservation = {
        ...current,
        state: nextState,
        updatedAt: nowIso()
      };
      state.ownerCleanup.scopes[ownerKey] = next;
      return next;
    });
  }

  getActiveQuiescenceEpoch(name: string): number | null {
    return this.state.quiescence.active[name]?.epoch ?? null;
  }

  getLatestLifecycleEpoch(name: string): number | null {
    return this.state.quiescence.latestByName[name] ?? null;
  }

  assertSessionMutable(name: string): void {
    this.assertWritable();
    assertSessionMutable(this.state, name);
  }

  async reserveQuiescence(
    name: string,
    purpose: "external" | "purge"
  ): Promise<SessionQuiescenceReservation> {
    return await this.mutate((state) => {
      const current = state.quiescence.active[name];
      if (current != null) {
        if (purpose === "external" && current.purpose === "purge") {
          const promoted: SessionQuiescenceReservation = {
            ...current,
            purpose: "external",
            updatedAt: nowIso()
          };
          state.quiescence.active[name] = promoted;
          state.quiescence.latestByName[name] = promoted.epoch;
          return promoted;
        }
        return current;
      }
      const lastEpoch = state.quiescence.lastEpoch;
      if (!Number.isSafeInteger(lastEpoch) || lastEpoch >= Number.MAX_SAFE_INTEGER) {
        throw new PuppenclawError(
          "QUIESCENCE_EPOCH_EXHAUSTED",
          `Session ${name} cannot allocate another quiescence epoch.`
        );
      }
      const epoch = lastEpoch + 1;
      const next: SessionQuiescenceReservation = {
        name,
        epoch,
        purpose,
        updatedAt: nowIso()
      };
      state.quiescence.lastEpoch = epoch;
      state.quiescence.active[name] = next;
      if (purpose === "external") {
        state.quiescence.latestByName[name] = epoch;
      }
      return next;
    });
  }

  async releaseQuiescence(name: string, epoch: number): Promise<SessionQuiescenceReservation> {
    return await this.mutate((state) => {
      const current = state.quiescence.active[name];
      const latestEpoch = state.quiescence.latestByName[name];
      if (current == null) {
        if (latestEpoch === epoch) {
          return {
            name,
            epoch,
            purpose: "external",
            updatedAt: nowIso()
          };
        }
        throw staleQuiescenceEpoch(name, epoch, undefined, latestEpoch, state.quiescence.lastEpoch);
      }
      if (current.epoch !== epoch) {
        throw staleQuiescenceEpoch(name, epoch, current, latestEpoch, state.quiescence.lastEpoch);
      }
      delete state.quiescence.active[name];
      return current;
    });
  }

  async enterLifecycleTurn(name: string, requestedEpoch?: number): Promise<{
    lifecycleEpoch: number | null;
    releasedQuiescence: boolean;
  }> {
    return await this.mutate((state) => {
      const latestEpoch = state.quiescence.latestByName[name];
      const activeReservation = state.quiescence.active[name];
      if (activeReservation?.purpose === "purge") {
        throw new PuppenclawError(
          "SESSION_QUIESCED",
          `Session ${name} is fenced by transient purge epoch ${activeReservation.epoch}.`,
          {
            name,
            quiescenceEpoch: activeReservation.epoch,
            latestEpoch: latestEpoch ?? null,
            lastEpoch: state.quiescence.lastEpoch
          }
        );
      }
      if (latestEpoch == null) {
        if (requestedEpoch != null) {
          throw staleLifecycleEpoch(name, requestedEpoch, undefined, state.quiescence.lastEpoch);
        }
        return { lifecycleEpoch: null, releasedQuiescence: false };
      }
      if (requestedEpoch == null) {
        const activeEpoch = state.quiescence.active[name]?.epoch;
        if (activeEpoch != null) {
          throw new PuppenclawError(
            "SESSION_QUIESCED",
            `Session ${name} is fenced by quiescence epoch ${activeEpoch}.`,
            { name, quiescenceEpoch: activeEpoch, latestEpoch, lastEpoch: state.quiescence.lastEpoch }
          );
        }
        throw new PuppenclawError(
          "LIFECYCLE_EPOCH_REQUIRED",
          `Session ${name} requires lifecycle epoch ${latestEpoch} before another turn can start.`,
          {
            name,
            requestedEpoch: null,
            activeEpoch: state.quiescence.active[name]?.epoch ?? null,
            latestEpoch,
            lastEpoch: state.quiescence.lastEpoch
          }
        );
      }
      if (requestedEpoch !== latestEpoch) {
        throw staleLifecycleEpoch(name, requestedEpoch, latestEpoch, state.quiescence.lastEpoch);
      }
      const current = state.quiescence.active[name];
      if (current != null && current.epoch !== requestedEpoch) {
        throw staleQuiescenceEpoch(
          name,
          requestedEpoch,
          current,
          latestEpoch,
          state.quiescence.lastEpoch
        );
      }
      if (current != null) {
        delete state.quiescence.active[name];
      }
      return {
        lifecycleEpoch: latestEpoch,
        releasedQuiescence: current != null
      };
    });
  }

  async flush(): Promise<void> {
    this.assertWritable();
    await this.mutate(() => undefined);
  }

  /**
   * Group commit: mutations queued while a write is pending (or in the same
   * event-loop turn) run in order on one clone, are validated once and written
   * once. Each caller resolves only after the write that contains its change.
   * If anything in a batch fails (a mutator throws, validation fails, or the
   * write fails), the batch is discarded and every mutation is retried alone,
   * exactly as before group commit, so one bad mutation never affects another.
   * Mutators must therefore be pure functions of the state they are given.
   */
  private async mutate<T>(mutator: (state: StoredState) => T): Promise<T> {
    this.assertWritable();
    this.pendingMutations += 1;
    try {
      return await new Promise<T>((resolve, reject) => {
        this.mutationQueue.push({
          mutator,
          resolve: resolve as (value: unknown) => void,
          reject
        });
        this.scheduleFlush();
      });
    } finally {
      this.pendingMutations -= 1;
    }
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    void this.enqueueMutation(async () => {
      await new Promise<void>((resolve) => {
        nextMacrotask(resolve);
      });
      this.flushScheduled = false;
      await this.commitBatch(this.mutationQueue.splice(0, this.mutationQueue.length));
    }).catch(() => undefined);
  }

  private async commitBatch(batch: PendingMutation[]): Promise<void> {
    if (batch.length === 0) {
      return;
    }
    this.stats.batches += 1;
    this.stats.mutations += batch.length;
    this.stats.largestBatch = Math.max(this.stats.largestBatch, batch.length);
    if (batch.length > 1) {
      const nextState = structuredClone(this.state);
      let results: unknown[] | null = [];
      try {
        for (const entry of batch) {
          results.push(entry.mutator(nextState));
        }
        if (!storedStateZod.safeParse(nextState).success) {
          results = null;
        }
      } catch {
        results = null;
      }
      if (results != null) {
        try {
          await this.writeState(nextState);
          for (const [index, entry] of batch.entries()) {
            entry.resolve(results[index]);
          }
          return;
        } catch {
          // Fall back to per-mutation writes below.
        }
      }
      this.stats.fallbacks += 1;
    }
    for (const entry of batch) {
      try {
        entry.resolve(await this.commitOne(entry.mutator));
      } catch (error) {
        entry.reject(error);
      }
    }
  }

  private async commitOne<T>(mutator: (state: StoredState) => T): Promise<T> {
    const nextState = structuredClone(this.state);
    const result = mutator(nextState);
    const validated = storedStateZod.safeParse(nextState);
    if (!validated.success) {
      throw new PuppenclawError(
        "INVALID_STATE_MUTATION",
        `Refusing to persist invalid session state: ${z.prettifyError(validated.error)}`
      );
    }
    await this.writeState(nextState);
    return result;
  }

  private async writeState(nextState: StoredState): Promise<void> {
    await this.persistSpoolIdentity();
    await writeJsonFileAtomic(this.statePath, nextState, { mode: 0o600 });
    this.stats.writes += 1;
    this.state = nextState;
  }

  /** A fresh spool is written just before its first state write. */
  private async persistSpoolIdentity(): Promise<void> {
    if (this.spool.persisted) {
      return;
    }
    await writeSpoolRecord(join(this.rootDir, SPOOL_FILE), this.spool.id);
    this.spool = { id: this.spool.id, persisted: true };
  }

  private async enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new PuppenclawError("STATE_STORE_CLOSED", "Session store is closed.");
    }
    const operation = this.mutationTail.then(run);
    this.mutationTail = operation.then(
      () => undefined,
      () => undefined
    );
    return await operation;
  }

  private assertWritable(): void {
    if (this.closed) {
      throw new PuppenclawError("STATE_STORE_CLOSED", "Session store is closed.");
    }
    if (!this.recovery.required) {
      return;
    }
    throw new PuppenclawError(
      "STATE_RECOVERY_REQUIRED",
      `Session state is read-only until an operator reset is performed: ${this.recovery.message}`,
      this.recovery
    );
  }
}

async function readSpoolId(path: string): Promise<string | null> {
  try {
    const parsed = spoolRecordZod.safeParse(JSON.parse(await readFile(path, "utf8")) as unknown);
    return parsed.success ? parsed.data.spoolId : null;
  } catch {
    return null;
  }
}

async function writeSpoolRecord(path: string, spoolId: string): Promise<string> {
  await writeJsonFileAtomic(path, { version: 1, spoolId, createdAt: nowIso() }, { mode: 0o600 });
  return spoolId;
}

async function loadStoredState(statePath: string): Promise<{
  state: StoredState;
  recovery: StateRecoveryStatus;
  origin: "fresh" | "loaded" | "recovery";
}> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { state: freshState(), recovery: { required: false }, origin: "fresh" };
    }
    return await recoveryState({
      statePath,
      reason: "unreadable",
      message: `Unable to read persisted session state: ${errorMessage(error)}`,
      quarantine: false
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return await recoveryState({
      statePath,
      reason: "corrupt",
      message: `Persisted session state is not valid JSON: ${errorMessage(error)}`,
      quarantine: true
    });
  }

  const compatibleState = upgradeCompatibleState(parsed);
  const validated = storedStateZod.safeParse(compatibleState);
  if (validated.success) {
    return {
      // Zod defaults are part of the compatible-state upgrade. Returning the
      // unparsed input unchanged would leave newly defaulted namespaces
      // undefined. Preserve the persisted session objects' insertion order,
      // which is observable in the daemon's legacy text status envelope.
      state: {
        ...(compatibleState as StoredState),
        sessionOwners: validated.data.sessionOwners,
        ownerCleanup: validated.data.ownerCleanup
      },
      recovery: { required: false },
      origin: "loaded"
    };
  }
  const version =
    parsed != null && typeof parsed === "object" && !Array.isArray(parsed) && "version" in parsed
      ? (parsed as { version?: unknown }).version
      : undefined;
  const incompatible = version !== SESSION_STORE_VERSION;
  return await recoveryState({
    statePath,
    reason: incompatible ? "incompatible" : "invalid",
    message: incompatible
      ? `Persisted session state version ${String(version)} is incompatible with required version ${SESSION_STORE_VERSION}.`
      : `Persisted session state failed validation: ${z.prettifyError(validated.error)}`,
    quarantine: true
  });
}

function upgradeCompatibleState(value: unknown): unknown {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const state = value as Record<string, unknown>;
  const rawQuiescence = state.quiescence;
  let quiescence = rawQuiescence;
  if (
    rawQuiescence != null &&
    typeof rawQuiescence === "object" &&
    !Array.isArray(rawQuiescence) &&
    !("latestByName" in rawQuiescence)
  ) {
    const legacyQuiescence = rawQuiescence as Record<string, unknown>;
    const active =
      legacyQuiescence.active != null &&
      typeof legacyQuiescence.active === "object" &&
      !Array.isArray(legacyQuiescence.active)
        ? (legacyQuiescence.active as Record<string, unknown>)
        : {};
    const latestByName: Record<string, number> = {};
    for (const [name, rawReservation] of Object.entries(active)) {
      if (
        rawReservation != null &&
        typeof rawReservation === "object" &&
        !Array.isArray(rawReservation)
      ) {
        const reservation = rawReservation as Record<string, unknown>;
        if (
          reservation.purpose === "external" &&
          typeof reservation.epoch === "number" &&
          Number.isSafeInteger(reservation.epoch) &&
          reservation.epoch > 0
        ) {
          latestByName[name] = reservation.epoch;
        }
      }
    }
    quiescence = { ...legacyQuiescence, latestByName };
  }
  return {
    ...state,
    ...(state.turnRequests == null ? { turnRequests: {} } : {}),
    ...(state.turnGenerations == null ? { turnGenerations: {} } : {}),
    ...(quiescence !== rawQuiescence ? { quiescence } : {})
  };
}

async function recoveryState(params: {
  statePath: string;
  reason: Extract<StateRecoveryStatus, { required: true }>['reason'];
  message: string;
  quarantine: boolean;
}): Promise<{ state: StoredState; recovery: StateRecoveryStatus; origin: "recovery" }> {
  const quarantinePath = params.quarantine ? await quarantineFile(params.statePath) : null;
  const detectedAt = nowIso();
  const recovery: StateRecoveryStatus = {
    required: true,
    reason: params.reason,
    message: params.message,
    detectedAt,
    ...(quarantinePath != null ? { quarantinePath } : {})
  };
  console.error(
    `${params.message} The store is in recovery-required read-only mode${
      quarantinePath != null ? `; previous state was preserved at ${quarantinePath}` : ""
    }.`
  );
  return { state: freshState(), recovery, origin: "recovery" };
}

async function acquireOwnerLease(rootDir: string): Promise<OwnerLease> {
  await ensureDir(rootDir);
  const leasePath = join(rootDir, OWNER_LEASE_FILE);
  const lease: OwnerLease = {
    version: OWNER_LEASE_VERSION,
    ownerId: randomUUID(),
    pid: process.pid,
    ...(await currentProcessStartIdentity()),
    acquiredAt: nowIso()
  };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await writeOwnerLeaseExclusive(leasePath, lease);
      return lease;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw new PuppenclawError(
          "STATE_OWNER_LEASE_FAILED",
          `Unable to acquire the session-state owner lease at ${leasePath}: ${errorMessage(error)}`
        );
      }
    }

    const existing = await readOwnerLease(leasePath);
    if (existing == null) {
      throw new PuppenclawError(
        "STATE_ROOT_IN_USE",
        `The session-state owner lease at ${leasePath} is unreadable; refusing to assume ownership.`
      );
    }
    if (await ownerLeaseMayBeLive(existing)) {
      throw new PuppenclawError(
        "STATE_ROOT_IN_USE",
        `Session state at ${rootDir} is already owned by process ${existing.pid}.`,
        { pid: existing.pid, acquiredAt: existing.acquiredAt }
      );
    }

    const stalePath = `${leasePath}.stale-${nowIso().replaceAll(":", "-")}-${randomUUID()}`;
    try {
      await rename(leasePath, stalePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        continue;
      }
      throw new PuppenclawError(
        "STATE_OWNER_LEASE_FAILED",
        `Unable to preserve stale session-state owner lease at ${leasePath}: ${errorMessage(error)}`
      );
    }
  }
  throw new PuppenclawError(
    "STATE_ROOT_IN_USE",
    `Session state at ${rootDir} changed ownership repeatedly; refusing to open it.`
  );
}

async function writeOwnerLeaseExclusive(path: string, lease: OwnerLease): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

async function readOwnerLease(path: string): Promise<OwnerLease | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const result = ownerLeaseZod.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function ownerLeaseMayBeLive(lease: OwnerLease): Promise<boolean> {
  try {
    process.kill(lease.pid, 0);
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
  if (process.platform !== "linux" || lease.processStartIdentity == null) {
    return true;
  }
  const current = await linuxProcessStartIdentity(lease.pid);
  return current == null || current === lease.processStartIdentity;
}

async function currentProcessStartIdentity(): Promise<{ processStartIdentity?: string }> {
  const identity = await linuxProcessStartIdentity(process.pid);
  return identity != null ? { processStartIdentity: identity } : {};
}

async function linuxProcessStartIdentity(pid: number): Promise<string | null> {
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
  const startTicks = fields[19];
  return startTicks != null ? `${pid}:${startTicks}` : null;
}

async function releaseOwnerLease(rootDir: string, lease: OwnerLease): Promise<void> {
  const path = join(rootDir, OWNER_LEASE_FILE);
  const current = await readOwnerLease(path);
  if (current?.ownerId !== lease.ownerId) {
    return;
  }
  await unlink(path).catch((error) => {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  });
  await syncDirectory(rootDir);
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unsupported on some platforms; the lease file itself
    // is still fsynced before it is considered acquired.
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function replaySessionSnapshot(
  session: SessionInfo
): TurnRequestSuccessOutcome["session"] {
  return structuredClone({
    name: session.name,
    state: session.state,
    lastActivity: session.lastActivity,
    ...(session.pendingQuestion != null
      ? { pendingQuestion: redactSensitiveText(session.pendingQuestion) }
      : {}),
    ...(session.lastError != null ? { lastError: redactSensitiveText(session.lastError) } : {}),
    ...(session.failureCode != null ? { failureCode: session.failureCode } : {}),
    ...(session.retryable != null ? { retryable: session.retryable } : {}),
    ...(session.activeTurn != null
      ? {
          activeTurn: {
            ...session.activeTurn,
            ...(session.activeTurn.error != null
              ? { error: redactSensitiveText(session.activeTurn.error) }
              : {})
          }
        }
      : {}),
    ...(session.tokenUsage != null ? { tokenUsage: session.tokenUsage } : {})
  });
}

function compactSuccessOutcome(
  outcome: Omit<TurnRequestSuccessOutcome, "session">,
  session: SessionInfo
): TurnRequestSuccessOutcome {
  const sanitizedOutput = redactSensitiveText(outcome.output);
  const truncationMarker = `[replay output truncated: kept latest content within ${MAX_TURN_REPLAY_OUTPUT_CHARS} chars]\n`;
  return {
    ...outcome,
    output:
      sanitizedOutput.length <= MAX_TURN_REPLAY_OUTPUT_CHARS
        ? sanitizedOutput
        : `${truncationMarker}${sanitizedOutput.slice(
            -(MAX_TURN_REPLAY_OUTPUT_CHARS - truncationMarker.length)
          )}`,
    session: replaySessionSnapshot(session)
  };
}

function compactOldestReplayOutcome(
  receipts: Record<string, TurnRequestReceipt>
): void {
  const settled = Object.values(receipts)
    .filter((receipt) => receipt.state === "settled")
    .sort((left, right) => {
      const byCompletion = Date.parse(left.completedAt ?? left.updatedAt) - Date.parse(right.completedAt ?? right.updatedAt);
      return byCompletion !== 0
        ? byCompletion
        : left.turnKey.localeCompare(right.turnKey);
    });
  if (settled.length < MAX_TURN_REQUEST_OUTCOMES_PER_SESSION) {
    return;
  }
  const oldest = settled[0];
  if (oldest == null) {
    return;
  }
  oldest.state = "tombstone";
  delete oldest.outcome;
  oldest.updatedAt = nowIso();
}

function requireRunningTurnRequest(
  state: StoredState,
  sessionName: string,
  turnKey: string,
  requestFingerprint: string
): TurnRequestReceipt {
  const receipt = state.turnRequests[sessionName]?.[turnKey];
  if (receipt == null) {
    throw new PuppenclawError(
      "TURN_RECEIPT_MISSING",
      `Turn key ${turnKey} has no durable receipt for session ${sessionName}.`
    );
  }
  if (receipt.requestFingerprint !== requestFingerprint) {
    throw new PuppenclawError(
      "TURN_KEY_CONFLICT",
      `Turn key ${turnKey} was already used for a different request in session ${sessionName}.`
    );
  }
  if (receipt.state !== "running") {
    throw new PuppenclawError(
      "TURN_RECEIPT_ALREADY_SETTLED",
      `Turn key ${turnKey} is already settled for session ${sessionName}.`
    );
  }
  return receipt;
}

function assertSessionMutable(state: StoredState, name: string): void {
  const epoch = state.quiescence.active[name]?.epoch;
  if (epoch == null) {
    return;
  }
  throw new PuppenclawError(
    "SESSION_QUIESCED",
    `Session ${name} is fenced by quiescence epoch ${epoch}.`,
    { name, quiescenceEpoch: epoch }
  );
}

function staleQuiescenceEpoch(
  name: string,
  epoch: number,
  current: SessionQuiescenceReservation | undefined,
  latestEpoch: number | undefined,
  lastEpoch: number
): PuppenclawError {
  return new PuppenclawError(
    "STALE_QUIESCENCE_EPOCH",
    `Quiescence epoch ${epoch} is not active for session ${name}.`,
    {
      name,
      requestedEpoch: epoch,
      activeEpoch: current?.epoch ?? null,
      latestEpoch: latestEpoch ?? null,
      lastEpoch
    }
  );
}

function staleLifecycleEpoch(
  name: string,
  requestedEpoch: number,
  latestEpoch: number | undefined,
  lastEpoch: number
): PuppenclawError {
  return new PuppenclawError(
    "STALE_LIFECYCLE_EPOCH",
    `Lifecycle epoch ${requestedEpoch} is not current for session ${name}.`,
    {
      name,
      requestedEpoch,
      activeEpoch: null,
      latestEpoch: latestEpoch ?? null,
      lastEpoch
    }
  );
}

function normalizeExposureRecord(
  exposure: Partial<ExposureRecord> & Pick<ExposureRecord, "bindingId" | "conversation">
): ExposureRecord {
  return {
    bindingId: exposure.bindingId,
    conversation: exposure.conversation,
    allowPurePipe: exposure.allowPurePipe ?? false,
    allowedAgents: exposure.allowedAgents ?? ["claude", "codex"],
    mode: exposure.mode ?? "execute",
    allowedVerbs: exposure.allowedVerbs ?? [...REMOTE_CONTROL_VERBS],
    allowedProjectRoots: exposure.allowedProjectRoots ?? [],
    updatedAt: exposure.updatedAt ?? nowIso()
  };
}
