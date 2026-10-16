import { AdvancedRuntime } from "../advanced/runtime.js";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { ZodError } from "zod";

import { AcpxSessionManager } from "../manager/acpx.js";
import { OrchestratorRuntime } from "../orchestrator/runtime.js";
import { OrchestratorStore } from "../orchestrator/store.js";
import type { PluginLogger } from "../shared/logger.js";
import { OutputRouter, type OutputRouteEvent } from "../shared/output-router.js";
import { REASONING_CAPABILITIES } from "../shared/reasoning.js";
import { PuppenclawError } from "../shared/errors.js";
import { SessionStore } from "../shared/store.js";
import { UsageLedgerStore } from "../shared/usage-ledger.js";
import { TurnStatisticsStore } from "../statistics/store.js";
import { TurnStatisticsRecorder } from "../statistics/recorder.js";
import { ComputeRuntime } from "../compute/runtime.js";
import { computeJobSpecZod } from "../compute/types.js";
import { ResourceMonitor } from "../resources/monitor.js";
import { resourcesHistoryParamsZod } from "../resources/types.js";
import { jsonToolResult } from "../shared/tool-results.js";
import {
  artifactListParamsZod,
  artifactReadParamsZod,
  campaignEventsParamsZod,
  campaignActionParamsZod,
  campaignRunParamsZod,
  campaignStatusParamsZod,
  contextSyncParamsZod,
  costParamsZod,
  focusParamsZod,
  forkParamsZod,
  logsParamsZod,
  ownerSessionCleanupParamsZod,
  ownerSessionListParamsZod,
  projectCreateParamsZod,
  quiescenceReleaseParamsZod,
  quiesceParamsZod,
  reassessmentReportParamsZod,
  reassessmentStartParamsZod,
  reassessmentStatusParamsZod,
  resumeParamsZod,
  siteStatusParamsZod,
  sendParamsZod,
  startParamsZod,
  statisticsContextZod,
  statusParamsZod,
  stopParamsZod,
  suspendParamsZod,
  unfocusParamsZod,
  workerManifestZod
} from "../shared/schema.js";
import type { ParsedPluginConfig, StateRecoveryStatus, ToolResult } from "../shared/types.js";
import { ensureDir, redactSensitiveText } from "../shared/utils.js";

export async function createDaemonServer(params: {
  config: ParsedPluginConfig;
  dataDir: string;
  logger?: PluginLogger;
}): Promise<{
  app: FastifyInstance;
}> {
  await ensureDir(params.dataDir);
  const logger: PluginLogger = params.logger ?? {
    info: (message: string) => console.info(message),
    warn: (message: string) => console.warn(message),
    error: (message: string) => console.error(message),
    debug: (message: string) => console.debug(message)
  };
  const app = Fastify({
    logger: false
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      const summary = error.issues
        .map((issue) => `${issue.path.map(String).join(".") || "(params)"}: ${issue.message}`)
        .join("; ");
      return reply.code(400).send({
        ok: false,
        code: "INVALID_PARAMS",
        error: redactSensitiveText(`Invalid parameters: ${summary}`)
      });
    }
    if (!(error instanceof PuppenclawError)) {
      return reply.code(500).send({
        ok: false,
        code: "INTERNAL_ERROR",
        error: redactSensitiveText(error instanceof Error ? error.message : String(error))
      });
    }
    const details = daemonLifecycleErrorDetails(error);
    return reply.code(daemonStatusForError(error.code)).send({
      ok: false,
      code: error.code,
      error: redactSensitiveText(error.message),
      ...(details != null ? { details } : {})
    });
  });

  // SECURITY: When config.daemonAuthToken is a non-empty string, every route
  // except GET /health and GET /capabilities requires
  // `Authorization: Bearer <token>` and replies 401 otherwise. When no token
  // is configured the daemon is fully open (unchanged legacy behavior): it is
  // then only safe on a loopback bind. Running with `--host 0.0.0.0` (or any
  // non-loopback bind) WITHOUT a token is unsafe — POST /orchestrator/campaign
  // can execute arbitrary shell commands.
  const authToken = params.config.daemonAuthToken?.trim() ?? "";
  if (authToken.length > 0) {
    const expectedHeader = Buffer.from(`Bearer ${authToken}`, "utf8");
    const openRoutes = new Set(["/health", "/capabilities"]);
    app.addHook("onRequest", async (request, reply) => {
      const path = request.url.split("?")[0] ?? "";
      if (request.method === "GET" && openRoutes.has(path)) {
        return;
      }
      const provided = Buffer.from(request.headers.authorization ?? "", "utf8");
      const authorized =
        provided.length === expectedHeader.length && timingSafeEqual(provided, expectedHeader);
      if (!authorized) {
        await reply.code(401).send({ ok: false, error: "unauthorized" });
      }
    });
  }

  const store = await SessionStore.open(params.dataDir);
  app.addHook("onRequest", async (request) => {
    if (
      request.method === "GET" ||
      request.url.split("?")[0] === "/recovery/reset" ||
      request.url.split("?")[0] === "/shutdown"
    ) {
      return;
    }
    const recovery = store.getRecoveryStatus();
    if (recovery.required) {
      throw new PuppenclawError(
        "STATE_RECOVERY_REQUIRED",
        `Daemon state is read-only until an operator reset is performed: ${recovery.message}`,
        recovery
      );
    }
  });
  const initialized = await (async () => {
    let orchestratorStore: OrchestratorStore | undefined;
    let usageLedger: UsageLedgerStore | undefined;
    let computeRuntime: ComputeRuntime | undefined;
    let resourceMonitor: ResourceMonitor | undefined;
    let statistics: TurnStatisticsRecorder | undefined;
    let advanced: AdvancedRuntime | undefined;
    try {
      orchestratorStore = await OrchestratorStore.open(join(params.dataDir, "orchestrator"));
      usageLedger = await UsageLedgerStore.open(join(params.dataDir, "usage"));
      computeRuntime = await ComputeRuntime.open({
        dataDir: params.dataDir,
        config: params.config
      });
      const statisticsStore = await TurnStatisticsStore.open(join(params.dataDir, "statistics"));
      statisticsStore.recoverInterrupted();
      statistics = new TurnStatisticsRecorder(statisticsStore, {
        listComputeJobs: () => computeRuntime?.listActiveJobs() ?? [],
        warn: (code) => logger.warn(code)
      });
      resourceMonitor = await ResourceMonitor.open({
        dataDir: params.dataDir,
        config: params.config,
        logger,
        sessionStore: store,
        computeJobs: {
          listActive: (sessionName?: string) => computeRuntime?.listActiveJobs(sessionName) ?? []
        }
      });
      resourceMonitor.start();
      const outputRouter = new OutputRouter(logger);
      advanced = await AdvancedRuntime.open(join(params.dataDir, "advanced"));
      const manager = new AcpxSessionManager({
        config: {
          ...params.config,
          backend: "local"
        },
        logger,
        store,
        outputRouter,
        ledger: usageLedger,
        statistics,
        advanced
      });
      advanced.attach({
        start: (request) => manager.start(request), quiesce: async (name) => { await manager.quiesce({ name }); },
        purge: async (name) => { await manager.purge({ name }); },
        getSession: (name) => store.getSession(name), getOwner: (name) => store.getSessionOwner(name) ?? undefined,
        contribution: (receipt) => {
          statistics!.observeBrokerReceipt(receipt.parentSessionName, receipt);
          if (receipt.state === "running" || receipt.usage.input === null || receipt.usage.output === null) return;
          const session = store.getSession(receipt.sessionName) ?? store.getSession(receipt.parentSessionName);
          if (!session) return;
          usageLedger!.append({ id: `advanced-${receipt.requestId}`, sessionName: receipt.parentSessionName, agent: session.agent, provider: receipt.providerId, model: receipt.model,
            usage: { input: Math.max(0, receipt.usage.input - (receipt.usage.cacheRead ?? 0) - (receipt.usage.cacheWrite ?? 0)), output: receipt.usage.output, cacheRead: receipt.usage.cacheRead ?? 0, cacheWrite: receipt.usage.cacheWrite ?? 0, total: receipt.usage.total ?? receipt.usage.input + receipt.usage.output },
            durationMs: Date.parse(receipt.updatedAt) - Date.parse(receipt.createdAt), timestamp: receipt.updatedAt, turnId: receipt.attemptId, role: receipt.role, threads: 1 });
        },
      });
      await manager.reconcilePersistedSessions();
      await advanced.recover();
      const orchestrator = new OrchestratorRuntime({
        config: {
          ...params.config,
          backend: "local"
        },
        logger,
        store: orchestratorStore,
        sessionStore: store,
        sessionManager: manager
      });
      await orchestrator.recoverInterruptedCampaigns();
      return {
        orchestratorStore,
        usageLedger,
        computeRuntime,
        resourceMonitor,
        statistics,
        advanced,
        outputRouter,
        manager,
        orchestrator
      };
    } catch (error) {
      resourceMonitor?.close();
      await advanced?.close();
      await statistics?.close();
      computeRuntime?.close();
      usageLedger?.close();
      orchestratorStore?.close();
      await store.close();
      throw error;
    }
  })();
  const {
    orchestratorStore,
    usageLedger,
    computeRuntime,
    resourceMonitor,
    statistics,
    advanced,
    outputRouter,
    manager,
    orchestrator
  } = initialized;

  const ok = (result: ToolResult) => result;
  const ownerCleanupTails = new Map<string, Promise<void>>();

  app.get("/health", async () => {
    const recovery = store.getRecoveryStatus();
    return {
      ok: !recovery.required,
      sessions: store.listSessions().length,
      stateRecovery: publicRecoveryStatus(recovery)
    };
  });

  app.get("/capabilities", async () => ({
    ok: true,
    version: 1,
    advancedOrchestration: { version: 1, durableJobs: true, recordedTransport: true, namespaceRequired: true, workerJoinContinuation: true, incrementalResults: true, aggregateBulkConcurrency: true, nativeClaudeOAuthRefresh: 1 },
    sessionStart: true,
    sessionStartStream: true,
    sessionSend: true,
    sessionSendStream: true,
    sessionTurnIdempotency: {
      version: 1,
      durable: true,
      concurrentWait: true,
      terminalReplay: true,
      requestFingerprint: true,
      terminalReplayRetention: 64,
      turnKeyRetention: 4096
    },
    conversationStatistics: { version: 1, durable: true, cursorUpdates: true, contextRequired: true, cpuCoverage: "partial" },
    sessionModelProviderRefresh: true,
    interactionModes: ["plan", "execute"],
    codexTurnPolicy: {
      version: 1,
      serverControlled: true,
      userExecutionMarkersTrusted: false
    },
    codexLocalSubagents: {
      version: 1,
      modelProviderField: "subagents",
      cliModelOverrides: false
    },
    structuredTurnSignals: true,
    structuredOutputEvents: true,
    providerFailureContracts: {
      version: 3,
      codes: ["PROVIDER_AUTHENTICATION_REQUIRED", "PROVIDER_CONNECTION_FAILED", "PROVIDER_AUTHENTICATION_BUSY", "PROVIDER_PAUSED"],
      retryability: true,
      durableReplay: true
    },
    ...(authToken.length > 0
      ? {
          sessionOwnerCleanup: {
            version: 1,
            authenticated: true,
            opaqueOwnerKey: true,
            durableFence: true,
            authoritativeNameAdoption: true,
            operations: ["list", "quiesce", "purge"]
          }
        }
      : {}),
    sessionOutput: true,
    sessionPurge: true,
    sessionPurgeTransientFencing: true,
    sessionQuiesce: true,
    sessionQuiesceRelease: true,
    sessionQuiescence: {
      version: 2,
      durable: true,
      releaseRequired: true,
      mutationFencing: true,
      dispatchEpoch: true,
      unknownSessionFencing: true,
      historyPersistent: true
    },
    sessionSuspend: true,
    sessionFocus: true,
    sessionFork: true,
    sessionSkills: true,
    stateRecovery: {
      version: 1,
      status: publicRecoveryStatus(store.getRecoveryStatus()),
      explicitReset: true,
      readOnlyWhenRequired: true,
      ownerLease: true
    },
    reasoning: REASONING_CAPABILITIES,
    claudeWorkflows: { version: 1, runtimeVerified: true, configId: "ocsl_workflow_v1" },
    maxSessions: {
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      current: params.config.maxSessions
    },
    streamOutput: params.config.streamOutput,
    defaultAgent: params.config.defaultAgent
  }));

  app.get("/compute/capacity", async () => computeRuntime.capacity());

  app.post("/compute/jobs", async (request, reply) => {
    try {
      return await computeRuntime.submit(computeJobSpecZod.parse(request.body));
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/compute/jobs/:id", async (request, reply) => {
    const record = await computeRuntime.get((request.params as { id: string }).id);
    return record ?? reply.code(404).send({ error: "Compute job not found." });
  });

  app.get("/compute/jobs/:id/logs", async (request, reply) => {
    const tailBytes = Number((request.query as { tailBytes?: string }).tailBytes ?? 65_536);
    const logs = await computeRuntime.logs((request.params as { id: string }).id, tailBytes);
    return logs == null
      ? reply.code(404).send({ error: "Compute job not found." })
      : reply.type("text/plain; charset=utf-8").send(logs);
  });

  app.post("/compute/jobs/:id/cancel", async (request, reply) => {
    const record = await computeRuntime.cancel((request.params as { id: string }).id);
    return record ?? reply.code(404).send({ error: "Compute job not found." });
  });

  app.addHook("onClose", async () => {
    resourceMonitor.close();
    await advanced.close();
    await statistics.close();
    computeRuntime.close();
    orchestratorStore.close();
    usageLedger.close();
    await store.close();
  });

  app.post("/recovery/reset", async (request, reply) => {
    const confirmation = (request.body as { confirm?: unknown } | null)?.confirm;
    if (confirmation !== "reset-session-state") {
      return reply.code(400).send({
        ok: false,
        code: "RESET_CONFIRMATION_REQUIRED",
        error: 'Recovery reset requires {"confirm":"reset-session-state"}.'
      });
    }
    return {
      ok: true,
      stateRecovery: await store.resetRecovery()
    };
  });

  app.get("/sessions", async () => ok(await manager.status(statusParamsZod.parse({}))));

  app.post("/sessions/owner/list", async (request) => {
    assertOwnerCleanupAuthentication(authToken);
    const parsed = ownerSessionListParamsZod.parse(request.body);
    return {
      ok: true,
      sessions: store.listSessionsByOwner(parsed.ownerKey).map(ownerSessionSummary),
      cleanup: publicOwnerCleanup(store.getOwnerCleanup(parsed.ownerKey))
    };
  });

  app.post("/sessions/owner/quiesce", async (request) => {
    assertOwnerCleanupAuthentication(authToken);
    const parsed = ownerSessionCleanupParamsZod.parse(request.body);
    return await withOwnerCleanupLock(ownerCleanupTails, parsed.ownerKey, async () => {
      const reservation = await store.reserveOwnerCleanup(
        parsed.ownerKey,
        parsed.operationKey,
        parsed.sessionNames
      );
      const sessions = store.listSessionsByOwner(parsed.ownerKey);
      try {
        for (const session of sessions) {
          await manager.quiesce({ name: session.name });
        }
      } catch (error) {
        throw ownerCleanupIncomplete("quiesce", sessions.length, error);
      }
      return {
        ok: true,
        adopted: parsed.sessionNames.length,
        quiesced: sessions.length,
        sessions: store.listSessionsByOwner(parsed.ownerKey).map(ownerSessionSummary),
        cleanup: publicOwnerCleanup(reservation)
      };
    });
  });

  app.post("/sessions/owner/purge", async (request) => {
    assertOwnerCleanupAuthentication(authToken);
    const parsed = ownerSessionCleanupParamsZod.parse(request.body);
    return await withOwnerCleanupLock(ownerCleanupTails, parsed.ownerKey, async () => {
      await store.reserveOwnerCleanup(
        parsed.ownerKey,
        parsed.operationKey,
        parsed.sessionNames
      );
      await store.promoteOwnerCleanup(parsed.ownerKey, parsed.operationKey, "purging");
      const sessions = store.listSessionsByOwner(parsed.ownerKey);
      try {
        for (const session of sessions) {
          if (store.getSession(session.name)) await manager.purge({ name: session.name });
        }
      } catch (error) {
        throw ownerCleanupIncomplete("purge", sessions.length, error);
      }
      await advanced.purgeOwner(parsed.ownerKey);
      const remaining = store.listSessionsByOwner(parsed.ownerKey);
      if (remaining.length > 0) {
        throw ownerCleanupIncomplete("purge", sessions.length, undefined, remaining.length);
      }
      const reservation = await store.promoteOwnerCleanup(
        parsed.ownerKey,
        parsed.operationKey,
        "purged"
      );
      return {
        ok: true,
        adopted: parsed.sessionNames.length,
        purged: sessions.length,
        sessions: [],
        cleanup: publicOwnerCleanup(reservation)
      };
    });
  });

  app.get("/skills", async () => ok(await manager.listSkills()));

  app.get("/session/:name", async (request) =>
    ok(
      await manager.status(
        statusParamsZod.parse({
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.get("/session/:name/output", async (request) =>
    ok(
      await manager.output(
        statusParamsZod.parse({
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.get("/session/:name/cost", async (request) => {
    const limit = boundedCostHistoryLimit((request.query as { limit?: unknown } | undefined)?.limit);
    return ok(
      await manager.cost(
        costParamsZod.parse({
          name: (request.params as { name: string }).name,
          ...(limit != null ? { limit } : {})
        })
      )
    );
  });

  app.get("/session/:name/processes", async (request) =>
    ok(
      jsonToolResult(
        await resourceMonitor.sessionProcesses((request.params as { name: string }).name),
        "Session processes"
      )
    )
  );

  app.get("/resources", async () =>
    ok(jsonToolResult(await resourceMonitor.snapshot(), "Resource usage"))
  );

  app.get("/orchestration/jobs", async (request, reply) => {
    const query = request.query as { session?: string; "metadata-only"?: string; view?: string; after?: string; limit?: string };
    if (query.view === "summary") {
      try { return advanced.jobSummaries(query.session, { after: Number(query.after ?? 0), limit: Number(query.limit ?? 100) }); }
      catch (error) { if (!(error instanceof RangeError)) throw error; return reply.code(400).send({ code: "INVALID_WORKER_CURSOR", error: error.message }); }
    }
    if (query["metadata-only"] === "true") return { jobs: advanced.store.jobHeaders(query.session).map(({ jobId, resumedFromJobId, parentSessionName, attemptId, kind, state, createdAt, updatedAt }) => ({
      jobId, resumedFromJobId, parentSessionName, attemptId, kind, state, createdAt, updatedAt
    })) };
    return { jobs: advanced.jobs(query.session) };
  });
  app.get("/orchestration/jobs/:jobId/results", async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const query = request.query as { session?: string; after?: string; limit?: string };
    if (!query.session) throw new PuppenclawError("WORKER_NOT_FOUND", "A parent session is required.");
    try { return advanced.jobResults(query.session, jobId, { after: Number(query.after ?? 0), limit: Number(query.limit ?? 100) }); }
    catch (error) { if (!(error instanceof RangeError)) throw error; return reply.code(400).send({ code: "INVALID_WORKER_CURSOR", error: error.message }); }
  });
  app.get("/orchestration/receipts", async (request) => { const query = request.query as { session?: string; attempt?: string }; return { receipts: advanced.store.receipts(query.session, query.attempt) }; });

  app.get("/statistics/turns", async (request, reply) => {
    const query = request.query as { cursor?: string; limit?: string };
    try {
      return ok(jsonToolResult(statistics.store.page(query.cursor ?? "0", query.limit == null ? 100 : Number(query.limit)), "Conversation turn statistics"));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return reply.code(400).send({ code: "INVALID_STATISTICS_CURSOR", message: "Invalid statistics cursor or limit." });
    }
  });

  app.post("/statistics/chats/:chatId/purge", async (request) => {
    if (!authToken) throw new PuppenclawError("DAEMON_AUTH_REQUIRED", "Permanent statistics erasure requires configured daemon authentication.");
    const chatId = statisticsContextZod.shape.chatId.parse((request.params as { chatId: string }).chatId);
    return ok(jsonToolResult(statistics.purgeChat(chatId), "Permanently erased conversation statistics"));
  });

  app.get("/resources/history", async (request, reply) => {
    const query = request.query as {
      since?: string;
      until?: string;
      bucketSeconds?: string;
      session?: string;
    };
    try {
      const parsed = resourcesHistoryParamsZod.parse({
        ...(query.since != null ? { since: query.since } : {}),
        ...(query.until != null ? { until: query.until } : {}),
        ...(query.bucketSeconds != null ? { bucketSeconds: Number(query.bucketSeconds) } : {}),
        ...(query.session != null ? { session: query.session } : {})
      });
      return ok(jsonToolResult(resourceMonitor.history(parsed), "Resource usage history"));
    } catch (error) {
      if (error instanceof PuppenclawError) {
        throw error;
      }
      return reply.code(400).send({
        ok: false,
        code: "INVALID_ARGUMENT",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/usage", async (request) =>
    ok(
      await manager.cost(
        costParamsZod.parse({
          since: (request.query as { since?: string }).since,
          format: (request.query as { format?: "text" | "json" }).format
        })
      )
    )
  );

  app.post("/session/start", async (request) => {
    const parsed = startParamsZod.parse(request.body);
    if (parsed.ownerKey != null) {
      assertOwnerCleanupAuthentication(authToken);
    }
    return ok(await manager.start(parsed));
  });

  app.post("/session/start/stream", async (request, reply) => {
    const parsed = startParamsZod.parse(request.body);
    if (parsed.ownerKey != null) {
      assertOwnerCleanupAuthentication(authToken);
    }
    return streamToolResult({
      reply,
      sessionName: parsed.name,
      outputRouter,
      subscribeToSessionOutput: parsed.turnKey == null,
      run: async () => ok(await manager.start(parsed))
    });
  });

  app.post("/session/:name/send", async (request) =>
    ok(
      await manager.send(
        sendParamsZod.parse({
          ...(request.body as Record<string, unknown>),
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.post("/session/:name/send/stream", async (request, reply) => {
    const parsed = sendParamsZod.parse({
      ...(request.body as Record<string, unknown>),
      name: (request.params as { name: string }).name
    });
    return streamToolResult({
      reply,
      sessionName: parsed.name,
      outputRouter,
      subscribeToSessionOutput: parsed.turnKey == null,
      run: async () => ok(await manager.send(parsed))
    });
  });

  app.post("/session/:name/resume", async (request) =>
    ok(
      await manager.resume(
        resumeParamsZod.parse({
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.post("/session/:name/suspend", async (request) =>
    ok(
      await manager.suspend(
        suspendParamsZod.parse({
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.post("/session/:name/focus", async (request) =>
    ok(
      await manager.focus(
        focusParamsZod.parse({
          ...(request.body as Record<string, unknown>),
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.post("/session/:name/unfocus", async (request) =>
    ok(
      await manager.unfocus(
        unfocusParamsZod.parse({
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.delete("/session/:name", async (request) =>
    ok(
      await manager.stop(
        stopParamsZod.parse({
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.post("/session/:name/purge", async (request) =>
    ok(
      await manager.purge(
        stopParamsZod.parse({
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.post("/session/:name/quiesce", async (request) =>
    ok(
      await manager.quiesce(
        quiesceParamsZod.parse({
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.post("/session/:name/quiesce/release", async (request) =>
    ok(
      await manager.releaseQuiescence(
        quiescenceReleaseParamsZod.parse({
          ...(request.body as Record<string, unknown>),
          name: (request.params as { name: string }).name
        })
      )
    )
  );

  app.post("/session/:name/fork", async (request) =>
    ok(
      await manager.fork(
        forkParamsZod.parse({
          ...(request.body as Record<string, unknown>),
          source: (request.params as { name: string }).name
        })
      )
    )
  );

  app.post("/gc", async () => {
    await manager.gc();
    return { ok: true };
  });

  app.post("/orchestrator/project", async (request) =>
    ok(await orchestrator.createProject(projectCreateParamsZod.parse(request.body)))
  );

  app.post("/orchestrator/worker", async (request) =>
    ok(await orchestrator.registerWorker(workerManifestZod.parse(request.body)))
  );

  app.post("/orchestrator/context-sync", async (request) =>
    ok(await orchestrator.syncContext(contextSyncParamsZod.parse(request.body)))
  );

  app.post("/orchestrator/campaign", async (request) =>
    ok(await orchestrator.runCampaign(campaignRunParamsZod.parse(request.body)))
  );

  app.get("/orchestrator/status", async (request) =>
    ok(
      await orchestrator.status(
        campaignStatusParamsZod.parse({
          campaignId: (request.query as { campaignId?: string }).campaignId,
          projectId: (request.query as { projectId?: string }).projectId
        })
      )
    )
  );

  app.get("/orchestrator/artifacts", async (request) =>
    ok(
      await orchestrator.listArtifacts(
        artifactListParamsZod.parse({
          campaignId: (request.query as { campaignId?: string }).campaignId,
          projectId: (request.query as { projectId?: string }).projectId
        })
      )
    )
  );

  app.get("/orchestrator/artifacts/:artifactId/content", async (request) =>
    ok(
      await orchestrator.readArtifact(
        artifactReadParamsZod.parse({
          artifactId: (request.params as { artifactId: string }).artifactId,
          limitChars:
            (request.query as { limitChars?: string }).limitChars != null
              ? Number((request.query as { limitChars?: string }).limitChars)
              : undefined,
          format: (request.query as { format?: "text" | "json" }).format
        })
      )
    )
  );

  app.get("/orchestrator/events", async (request) =>
    ok(
      await orchestrator.campaignEvents(
        campaignEventsParamsZod.parse({
          campaignId: (request.query as { campaignId?: string }).campaignId,
          after: (request.query as { after?: string }).after,
          limit:
            (request.query as { limit?: string }).limit != null
              ? Number((request.query as { limit?: string }).limit)
              : undefined,
          format: (request.query as { format?: "text" | "json" }).format
        })
      )
    )
  );

  app.post("/orchestrator/approve", async (request) =>
    ok(await orchestrator.approve(campaignActionParamsZod.parse(request.body)))
  );

  app.post("/orchestrator/cancel", async (request) =>
    ok(await orchestrator.cancel(campaignActionParamsZod.parse(request.body)))
  );

  app.post("/orchestrator/reassessment", async (request) =>
    ok(await orchestrator.startReassessment(reassessmentStartParamsZod.parse(request.body)))
  );

  app.get("/orchestrator/reassessment/status", async (request) =>
    ok(
      await orchestrator.reassessmentStatus(
        reassessmentStatusParamsZod.parse({
          reassessmentId: (request.query as { reassessmentId?: string }).reassessmentId,
          projectId: (request.query as { projectId?: string }).projectId,
          format: (request.query as { format?: "text" | "json" }).format
        })
      )
    )
  );

  app.get("/orchestrator/reassessment/report", async (request) =>
    ok(
      await orchestrator.reassessmentReport(
        reassessmentReportParamsZod.parse({
          reassessmentId: (request.query as { reassessmentId?: string }).reassessmentId,
          format: (request.query as { format?: "text" | "json" }).format
        })
      )
    )
  );

  app.get("/site/status", async (request) =>
    ok(
      await orchestrator.siteStatus(
        siteStatusParamsZod.parse({
          verbose: (request.query as { verbose?: string }).verbose === "true",
          format: (request.query as { format?: "text" | "json" }).format
        })
      )
    )
  );

  app.get("/site/logs", async (request) =>
    ok(
      await orchestrator.logs(
        logsParamsZod.parse({
          sessionName: (request.query as { sessionName?: string }).sessionName,
          campaignId: (request.query as { campaignId?: string }).campaignId,
          runId: (request.query as { runId?: string }).runId,
          limitChars:
            (request.query as { limitChars?: string }).limitChars != null
              ? Number((request.query as { limitChars?: string }).limitChars)
              : undefined,
          follow: (request.query as { follow?: string }).follow === "true",
          format: (request.query as { format?: "text" | "json" }).format
        })
      )
    )
  );

  app.post("/shutdown", async (_request, reply) => {
    reply.send({ ok: true });
    queueMicrotask(() => {
      void app.close();
    });
  });

  return { app };
}

/**
 * `?limit=` for per-session cost history, clamped to the schema's 1..1000.
 * A missing or non-numeric value keeps the manager default.
 */
function boundedCostHistoryLimit(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^\s*\d{1,12}\s*$/u.test(raw)) {
    return undefined;
  }
  return Math.min(1000, Math.max(1, Number(raw)));
}

function publicRecoveryStatus(status: StateRecoveryStatus): Record<string, unknown> {
  if (!status.required) {
    return { required: false };
  }
  return {
    required: true,
    reason: status.reason,
    detectedAt: status.detectedAt,
    message: "Persisted daemon state requires an explicit operator reset."
  };
}

function daemonStatusForError(code: string): number {
  switch (code) {
    case "INVALID_PARAMS":
    case "MODEL_UNAVAILABLE":
      return 400;
    case "NO_SESSION":
      return 404;
    case "PROVIDER_AUTHENTICATION_REQUIRED":
      return 424;
    case "DAEMON_AUTH_REQUIRED":
    case "OWNER_CLEANUP_INCOMPLETE":
      return 503;
    case "OWNER_SCOPE_QUIESCED":
    case "SESSION_OWNER_CONFLICT":
    case "OWNER_CLEANUP_CONFLICT":
    case "OWNER_ADOPTION_UNPROVEN":
    case "SESSION_QUIESCED":
    case "STALE_QUIESCENCE_EPOCH":
    case "LIFECYCLE_EPOCH_REQUIRED":
    case "STALE_LIFECYCLE_EPOCH":
    case "TURN_ALREADY_RUNNING":
    case "SESSION_BUSY":
    case "STATISTICS_CONTEXT_REUSED":
    case "STATISTICS_CONTEXT_PURGED":
    case "TURN_KEY_CONFLICT":
    case "TURN_REPLAY_UNAVAILABLE":
    case "TURN_RECEIPT_CAPACITY_REACHED":
    case "STALE_TURN_GENERATION":
    case "FORK_TARGET_CLAIMED":
    case "RECOVERY_FENCE_ACTIVE":
    case "PROVIDER_PAUSED":
      return 409;
    case "QUIESCENCE_UNAVAILABLE":
    case "ACP_CONTROL_TIMEOUT":
    case "PROVIDER_CONNECTION_FAILED":
    case "PROVIDER_AUTHENTICATION_BUSY":
    case "STATE_RECOVERY_REQUIRED":
      return 503;
    default:
      return 500;
  }
}

function assertOwnerCleanupAuthentication(authToken: string): void {
  if (authToken.length === 0) {
    throw new PuppenclawError(
      "DAEMON_AUTH_REQUIRED",
      "Account-scoped cleanup requires daemon bearer authentication."
    );
  }
}

function ownerSessionSummary(session: {
  name: string;
  state: string;
  lastActivity: string;
  recoveryFence?: unknown;
}): Record<string, unknown> {
  return {
    name: session.name,
    state: session.state,
    lastActivity: session.lastActivity,
    recoveryRequired: session.recoveryFence != null
  };
}

function publicOwnerCleanup(
  reservation: {
    epoch: number;
    state: string;
    updatedAt: string;
  } | null
): Record<string, unknown> | null {
  return reservation == null
    ? null
    : {
        epoch: reservation.epoch,
        state: reservation.state,
        updatedAt: reservation.updatedAt
      };
}

function ownerCleanupIncomplete(
  stage: "quiesce" | "purge",
  matched: number,
  cause?: unknown,
  remaining?: number
): PuppenclawError {
  return new PuppenclawError(
    "OWNER_CLEANUP_INCOMPLETE",
    `Account-scoped ${stage} could not prove that every matched runner is terminal.`,
    {
      stage,
      matched,
      remaining: remaining ?? null,
      recoveryRequired: true,
      ...(cause instanceof PuppenclawError ? { causeCode: cause.code } : {})
    }
  );
}

async function withOwnerCleanupLock<T>(
  tails: Map<string, Promise<void>>,
  ownerKey: string,
  run: () => Promise<T>
): Promise<T> {
  const previous = tails.get(ownerKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(async () => await gate);
  tails.set(ownerKey, tail);
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release();
    if (tails.get(ownerKey) === tail) {
      tails.delete(ownerKey);
    }
  }
}

function daemonLifecycleErrorDetails(error: PuppenclawError): Record<string, unknown> | null {
  const turnReceipt = parseTurnReceipt(error.details?.turnReceipt);
  if (
    error.code === "PROVIDER_AUTHENTICATION_REQUIRED" ||
    error.code === "PROVIDER_CONNECTION_FAILED" ||
    error.code === "PROVIDER_AUTHENTICATION_BUSY" ||
    error.code === "PROVIDER_PAUSED"
  ) {
    return {
      ...(typeof error.details?.retryable === "boolean"
        ? { retryable: error.details.retryable }
        : {}),
      ...(turnReceipt != null ? { turnReceipt } : {})
    };
  }
  if (
    ![
      "NO_SESSION",
      "SESSION_QUIESCED",
      "STALE_QUIESCENCE_EPOCH",
      "LIFECYCLE_EPOCH_REQUIRED",
      "STALE_LIFECYCLE_EPOCH",
      "TURN_KEY_CONFLICT",
      "TURN_REPLAY_UNAVAILABLE",
      "QUIESCENCE_UNAVAILABLE",
      "OWNER_CLEANUP_INCOMPLETE"
    ].includes(error.code) ||
    error.details == null
  ) {
    return turnReceipt == null ? null : { turnReceipt };
  }
  const details: Record<string, unknown> = {
    ...(turnReceipt != null ? { turnReceipt } : {})
  };
  for (const key of [
    "name",
    "turnKey",
    "quiescenceEpoch",
    "requestedEpoch",
    "activeEpoch",
    "latestEpoch",
    "lastEpoch",
    "stage",
    "matched",
    "remaining",
    "recoveryRequired",
    "causeCode"
  ]) {
    const value = error.details[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      details[key] = value;
    }
  }
  if (error.details.transientFence === true) {
    details.transientFence = true;
  }
  return details;
}

function parseTurnReceipt(value: unknown): { turnKey: string; state: "accepted" | "replayed" } | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const turnKey = (value as { turnKey?: unknown }).turnKey;
  const state = (value as { state?: unknown }).state;
  return typeof turnKey === "string" && (state === "accepted" || state === "replayed")
    ? { turnKey, state }
    : null;
}

async function streamToolResult(params: {
  reply: FastifyReply;
  sessionName: string;
  outputRouter: OutputRouter;
  subscribeToSessionOutput?: boolean;
  run: () => Promise<ToolResult>;
}): Promise<FastifyReply> {
  let closed = false;
  let emittedProviderFailureCode: string | null = null;
  params.reply.raw.on("close", () => {
    closed = true;
  });
  params.reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });

  const heartbeat = setInterval(() => {
    if (closed || params.reply.raw.writableEnded) {
      return;
    }
    params.reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15_000);
  heartbeat.unref?.();

  const write = (
    event: OutputRouteEvent | { kind: "result"; result: ToolResult } | { kind: "done" }
  ): void => {
    if (closed || params.reply.raw.writableEnded) {
      return;
    }
    params.reply.raw.write(`event: ${event.kind}\n`);
    params.reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const subscription =
    params.subscribeToSessionOutput === false
      ? null
      : params.outputRouter.attach(params.sessionName, (event) => {
          if (event.kind === "error" && isProviderFailureCode(event.code)) {
            emittedProviderFailureCode = event.code;
          }
          write(event);
        });

  try {
    if (subscription != null) {
      write({
        kind: "chunk",
        sessionName: params.sessionName,
        text: ""
      });
    }
    const result = await params.run();
    const providerFailure = providerFailureEventFromResult(params.sessionName, result);
    if (
      providerFailure != null &&
      emittedProviderFailureCode !== providerFailure.code
    ) {
      write(providerFailure);
    }
    write({ kind: "result", result });
    write({ kind: "done" });
  } catch (error) {
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
    const lifecycleDetails =
      error instanceof PuppenclawError ? daemonLifecycleErrorDetails(error) : null;
    write({
      kind: "error",
      sessionName: params.sessionName,
      text: message,
      ...(error instanceof PuppenclawError ? { code: error.code } : {}),
      ...(error instanceof PuppenclawError && typeof error.details?.retryable === "boolean"
        ? { retryable: error.details.retryable }
        : {}),
      ...(lifecycleDetails != null ? { details: lifecycleDetails } : {})
    });
    write({ kind: "done" });
  } finally {
    clearInterval(heartbeat);
    // Identity-guarded: only removes this stream's own subscription, so a
    // racing second stream (e.g. rejected with TURN_ALREADY_RUNNING) can
    // never silence the first stream's live dispatcher.
    if (subscription != null) {
      params.outputRouter.detach(subscription);
    }
    if (!params.reply.raw.writableEnded) {
      params.reply.raw.end();
    }
  }

  return params.reply;
}

function isProviderFailureCode(code: unknown): code is string {
  return (
    code === "PROVIDER_AUTHENTICATION_REQUIRED" || code === "PROVIDER_CONNECTION_FAILED" ||
    code === "PROVIDER_AUTHENTICATION_BUSY" || code === "PROVIDER_PAUSED"
  );
}

function providerFailureEventFromResult(
  sessionName: string,
  result: ToolResult
): Extract<OutputRouteEvent, { kind: "error" }> | null {
  const failureCode = result.details.failureCode;
  if (!isProviderFailureCode(failureCode)) {
    return null;
  }
  const retryable = result.details.retryable;
  const output = result.details.output;
  const fallback = result.content.find((block) => block.type === "text")?.text ?? "Provider failure.";
  return {
    kind: "error",
    sessionName,
    text: redactSensitiveText(typeof output === "string" ? output : fallback),
    code: failureCode,
    ...(typeof retryable === "boolean" ? { retryable } : {})
  };
}
