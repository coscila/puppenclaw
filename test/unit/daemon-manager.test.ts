import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DaemonSessionManager } from "../../src/manager/daemon.js";
import { createDaemonServer } from "../../src/daemon/server.js";
import { OutputRouter } from "../../src/plugin/output-router.js";
import { REASONING_CAPABILITIES } from "../../src/shared/reasoning.js";
import type { SessionInfo } from "../../src/shared/types.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

async function resolveFakeDaemonCodexCommand(workspaceDir: string): Promise<string> {
  const commandPath = join(workspaceDir, "fake-daemon-codex.mjs");
  await writeFile(
    commandPath,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync, writeSync } from "node:fs";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
readFileSync(0, "utf8");

function emit(value) {
  writeSync(1, JSON.stringify(value) + "\\n");
}

writeSync(1, "MALFORMED DAEMON token=daemon-stream-secret\\n");
emit({
  type: "response_item",
  item: {
    type: "function_call",
    name: "exec_command",
    arguments: "{\\"cmd\\":\\"read private input\\",\\"authorization\\":\\"Bearer daemon-tool-secret\\"}"
  }
});
emit({
  type: "response_item",
  item: {
    type: "function_call_output",
    output: "raw daemon tool output token=daemon-output-secret"
  }
});
emit({
  type: "response_item",
  item: {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Daemon streamed answer." }]
  }
});
if (outputPath != null) {
  writeFileSync(outputPath, "Daemon canonical answer.", "utf8");
}
`,
    "utf8"
  );
  return `node "${commandPath.replaceAll('"', '\\"')}"`;
}

describe("DaemonSessionManager", () => {
  it("streams and persists typed Claude OAuth failures", async () => {
    const workspaceDir = await createTempDir("puppenclaw-daemon-claude-oauth-");
    const config = makeConfig({ acpxCommand: await resolveFakeAcpxCommand() });
    const { app } = await createDaemonServer({ config, dataDir: workspaceDir });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/session/start/stream",
        payload: {
          agent: "claude",
          name: "daemon-oauth-expired",
          directory: workspaceDir,
          task: "CLAUDE_OAUTH_EXPIRED",
          contextFiles: []
        }
      });
      const events = response.body
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "error",
          code: "PROVIDER_AUTHENTICATION_REQUIRED",
          retryable: false
        })
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "result",
          result: expect.objectContaining({
            details: expect.objectContaining({
              failureCode: "PROVIDER_AUTHENTICATION_REQUIRED",
              retryable: false,
              session: expect.objectContaining({
                failureCode: "PROVIDER_AUTHENTICATION_REQUIRED",
                retryable: false
              })
            })
          })
        })
      );
      expect(response.body).not.toContain("must-not-survive");

      const status = await app.inject({ method: "GET", url: "/session/daemon-oauth-expired" });
      expect(JSON.parse(status.body)).toMatchObject({
        details: {
          session: {
            state: "failed",
            failureCode: "PROVIDER_AUTHENTICATION_REQUIRED",
            retryable: false
          }
        }
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      label: "authentication",
      task: "CLAUDE_OAUTH_EXPIRED",
      code: "PROVIDER_AUTHENTICATION_REQUIRED",
      retryable: false,
      message:
        "Claude OAuth credentials have expired or are invalid. Contact the system administrator to sign in to Claude again."
    },
    {
      label: "network",
      task: "PROVIDER_CONNECTION_FAILED",
      code: "PROVIDER_CONNECTION_FAILED",
      retryable: true,
      message: "Claude is temporarily unreachable because of a network or provider outage. Please retry."
    }
  ])(
    "preserves Claude $label failure parity across keyed SSE and JSON replay",
    async ({ label, task, code, retryable, message }) => {
      const workspaceDir = await createTempDir(`puppenclaw-daemon-${label}-parity-`);
      const { app } = await createDaemonServer({
        config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
        dataDir: workspaceDir
      });
      const request = {
        agent: "claude",
        name: `daemon-${label}-parity`,
        directory: workspaceDir,
        task,
        turnKey: `provider:${label}:parity`,
        contextFiles: []
      };
      const events = (body: string): Array<Record<string, unknown>> =>
        body
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);

      try {
        const initial = await app.inject({
          method: "POST",
          url: "/session/start/stream",
          payload: request
        });
        const initialEvents = events(initial.body);
        expect(initialEvents.map((event) => event.kind)).toEqual(["error", "result", "done"]);
        expect(initialEvents[0]).toMatchObject({
          kind: "error",
          code,
          retryable,
          text: message
        });
        expect(initialEvents[1]).toMatchObject({
          kind: "result",
          result: {
            details: {
              session: { state: "failed", failureCode: code, retryable },
              output: message,
              outputRole: "status",
              failureCode: code,
              retryable,
              turnReceipt: { state: "accepted" }
            }
          }
        });

        const replay = await app.inject({
          method: "POST",
          url: "/session/start/stream",
          payload: request
        });
        const replayEvents = events(replay.body);
        expect(replayEvents.map((event) => event.kind)).toEqual(["error", "result", "done"]);
        expect(replayEvents[0]).toMatchObject({
          kind: "error",
          code,
          retryable,
          text: message
        });
        expect(replayEvents[1]).toMatchObject({
          result: {
            details: {
              output: message,
              failureCode: code,
              retryable,
              turnReceipt: { state: "replayed" }
            }
          }
        });

        const jsonReplay = await app.inject({
          method: "POST",
          url: "/session/start",
          payload: request
        });
        expect(jsonReplay.statusCode).toBe(200);
        expect(JSON.parse(jsonReplay.body)).toMatchObject({
          details: {
            session: { state: "failed", failureCode: code, retryable },
            output: message,
            outputRole: "status",
            failureCode: code,
            retryable,
            turnReceipt: { state: "replayed" }
          }
        });
        for (const response of [initial.body, replay.body, jsonReplay.body]) {
          expect(response).not.toContain("must-not-survive");
          expect(response).not.toContain("access token expired");
        }
      } finally {
        await app.close();
      }
    }
  );

  it("reports the daemon HTTP capabilities", async () => {
    const workspaceDir = await createTempDir("puppenclaw-capabilities-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const config = makeConfig({
      backend: "daemon",
      acpxCommand,
      daemonAuthToken: "capability-test-token",
      maxSessions: 7
    });

    const { app } = await createDaemonServer({
      config,
      dataDir: workspaceDir
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/capabilities"
      });
      const payload = JSON.parse(response.body) as {
        sessionStartStream?: boolean;
        sessionSendStream?: boolean;
        sessionTurnIdempotency?: unknown;
        sessionModelProviderRefresh?: boolean;
        codexTurnPolicy?: unknown;
        codexLocalSubagents?: unknown;
        sessionOwnerCleanup?: unknown;
        sessionOutput?: boolean;
        sessionPurge?: boolean;
        sessionQuiesce?: boolean;
        sessionQuiesceRelease?: boolean;
        sessionPurgeTransientFencing?: boolean;
        sessionQuiescence?: unknown;
        sessionSkills?: boolean;
        reasoning?: unknown;
        maxSessions?: { min?: number; max?: number; current?: number };
      };

      expect(response.statusCode).toBe(200);
      expect(payload.sessionStartStream).toBe(true);
      expect(payload.sessionSendStream).toBe(true);
      expect(payload.sessionTurnIdempotency).toEqual({
        version: 1,
        durable: true,
        concurrentWait: true,
        terminalReplay: true,
        requestFingerprint: true,
        terminalReplayRetention: 64,
        turnKeyRetention: 4096
      });
      expect(payload.sessionModelProviderRefresh).toBe(true);
      expect(payload.codexTurnPolicy).toEqual({
        version: 1,
        serverControlled: true,
        userExecutionMarkersTrusted: false
      });
      expect(payload.codexLocalSubagents).toEqual({
        version: 1,
        modelProviderField: "subagents",
        cliModelOverrides: false
      });
      expect(payload.sessionOwnerCleanup).toEqual({
        version: 1,
        authenticated: true,
        opaqueOwnerKey: true,
        durableFence: true,
        authoritativeNameAdoption: true,
        operations: ["list", "quiesce", "purge"]
      });
      expect(payload.sessionOutput).toBe(true);
      expect(payload.sessionPurge).toBe(true);
      expect(payload.sessionQuiesce).toBe(true);
      expect(payload.sessionQuiesceRelease).toBe(true);
      expect(payload.sessionPurgeTransientFencing).toBe(true);
      expect(payload.sessionQuiescence).toEqual({
        version: 2,
        durable: true,
        releaseRequired: true,
        mutationFencing: true,
        dispatchEpoch: true,
        unknownSessionFencing: true,
        historyPersistent: true
      });
      expect(payload.sessionSkills).toBe(true);
      expect(payload.reasoning).toEqual(REASONING_CAPABILITIES);
      expect(payload.maxSessions).toEqual({
        min: 1,
        max: 100,
        current: 7
      });
    } finally {
      await app.close();
    }
  });

  it("streams tool protocol only as structured daemon activity", async () => {
    const workspaceDir = await createTempDir("puppenclaw-daemon-codex-stream-");
    const codexCommand = await resolveFakeDaemonCodexCommand(workspaceDir);
    const config = makeConfig({
      backend: "daemon",
      agentCommands: { codex: codexCommand }
    });
    const { app } = await createDaemonServer({ config, dataDir: workspaceDir });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/session/start/stream",
        payload: {
          agent: "codex",
          name: "daemon-codex-stream",
          directory: workspaceDir,
          task: "Run a bounded tool turn.",
          modelProviderId: "local-compatible",
          modelProvider: {
            id: "local-compatible",
            kind: "codex-openai-compatible",
            model: "local-model"
          }
        }
      });
      const events = response.body
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
      const visibleEvents = events.filter((event) =>
        ["chunk", "final", "result", "error"].includes(String(event.kind))
      );
      const visibleSurfaces = JSON.stringify(visibleEvents);

      expect(response.statusCode).toBe(200);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "activity",
          activity: expect.objectContaining({
            type: "tool_call",
            title: "exec_command",
            text: expect.stringContaining("Bearer [redacted]") as string
          })
        })
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "activity",
          activity: expect.objectContaining({
            type: "tool_output",
            text: expect.stringContaining("raw daemon tool output") as string
          })
        })
      );
      expect(events).toContainEqual(
        expect.objectContaining({ kind: "final", text: "Daemon canonical answer." })
      );
      for (const hiddenProtocolText of [
        "[tool]",
        "[tool output]",
        "MALFORMED DAEMON",
        "daemon-stream-secret",
        "daemon-tool-secret",
        "read private input",
        "raw daemon tool output",
        "daemon-output-secret"
      ]) {
        expect(visibleSurfaces).not.toContain(hiddenProtocolText);
      }
      expect(JSON.stringify(events)).not.toContain("daemon-tool-secret");
      expect(JSON.stringify(events)).not.toContain("daemon-output-secret");
    } finally {
      await app.close();
    }
  });

  it("talks to the daemon HTTP surface", async () => {
    const workspaceDir = await createTempDir("puppenclaw-daemon-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const config = makeConfig({
      backend: "daemon",
      acpxCommand
    });

    const { app } = await createDaemonServer({
      config,
      dataDir: workspaceDir
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const requestUrl = new URL(
        typeof input === "string" || input instanceof URL ? String(input) : input.url
      );
      const method = (init?.method ?? "GET") as "GET" | "POST" | "DELETE";
      const payload =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      const response = (await app.inject({
        method,
        url: `${requestUrl.pathname}${requestUrl.search}`,
        ...(payload != null ? { payload } : {}),
        ...(init?.headers != null ? { headers: init.headers as Record<string, string> } : {})
      } as never)) as {
        body: string;
        statusCode: number;
        headers: Record<string, string>;
      };
      return new Response(response.body, {
        status: response.statusCode,
        headers: response.headers
      });
    };

    const manager = new DaemonSessionManager({
      config: {
        ...config,
        daemonUrl: "http://puppenclaw.test"
      },
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      outputRouter: new OutputRouter({
        info() {},
        warn() {},
        error() {},
        debug() {}
      })
    });

    try {
      const result = await manager.start({
        agent: "codex",
        name: "daemon-demo",
        directory: workspaceDir,
        task: "Run through the daemon path.",
        contextFiles: []
      });
      const startDetails = result.details as { session: SessionInfo };
      expect(startDetails.session.name).toBe("daemon-demo");

      const approved = await manager.send({
        name: "daemon-demo",
        message: "REPORT_PERMISSION_MODE",
        permissionMode: "approve-all",
        contextFiles: []
      });
      const approvedDetails = approved.details as { session: SessionInfo; output: string };
      expect(approvedDetails.output).toBe("Permission mode: approve-all");
      expect(approvedDetails.session.permissionMode).toBe("approve-reads");

      const following = await manager.send({
        name: "daemon-demo",
        message: "REPORT_PERMISSION_MODE",
        contextFiles: []
      });
      const followingDetails = following.details as { session: SessionInfo; output: string };
      expect(followingDetails.output).toBe("Permission mode: approve-reads");
      expect(followingDetails.session.permissionMode).toBe("approve-reads");

      const cost = await manager.cost({ name: "daemon-demo" });
      const costDetails = cost.details as { name: string };
      expect(costDetails.name).toBe("daemon-demo");

      const output = await manager.output({ name: "daemon-demo" });
      const outputDetails = output.details as {
        output: { text: string; source: string; complete: boolean };
      };
      expect(outputDetails.output.text).toBe("Permission mode: approve-reads");
      expect(outputDetails.output.source).toBe("active-turn");
      expect(outputDetails.output.complete).toBe(true);

      const quiesced = await manager.quiesce({ name: "daemon-demo" });
      const quiescedDetails = quiesced.details as {
        quiescenceEpoch: number;
        runtimeClosed: boolean;
      };
      expect(quiescedDetails).toMatchObject({
        quiescenceEpoch: 1,
        runtimeClosed: true
      });
      await expect(
        manager.send({
          name: "daemon-demo",
          message: "This turn is fenced.",
          contextFiles: []
        })
      ).rejects.toMatchObject({ code: "SESSION_QUIESCED" });

      const resumed = await manager.send({
        name: "daemon-demo",
        message: "Resume through the current lifecycle.",
        lifecycleEpoch: 1,
        contextFiles: []
      });
      expect((resumed.details as { session: SessionInfo }).session.state).not.toBe("running");
      await expect(
        manager.send({
          name: "daemon-demo",
          message: "A stale dispatch must stay rejected.",
          lifecycleEpoch: 2,
          contextFiles: []
        })
      ).rejects.toMatchObject({ code: "STALE_LIFECYCLE_EPOCH" });

      const purge = await manager.purge({ name: "daemon-demo" });
      expect((purge.details as { purged: boolean }).purged).toBe(true);
      await expect(
        manager.releaseQuiescence({
          name: "daemon-demo",
          epoch: (purge.details as { quiescenceEpoch: number }).quiescenceEpoch
        })
      ).rejects.toMatchObject({ code: "STALE_QUIESCENCE_EPOCH" });
      await expect(manager.purge({ name: "daemon-demo" })).rejects.toMatchObject({
        code: "NO_SESSION"
      });
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });

  it("emits durable accepted and replayed receipts on keyed SSE without session output events", async () => {
    const workspaceDir = await createTempDir("puppenclaw-daemon-idempotency-");
    const { app } = await createDaemonServer({
      config: makeConfig({
        backend: "daemon",
        acpxCommand: await resolveFakeAcpxCommand()
      }),
      dataDir: workspaceDir
    });
    const request = {
      agent: "claude",
      name: "daemon-keyed",
      directory: workspaceDir,
      task: "ASK_USER",
      contextFiles: [],
      turnKey: "queue:daemon-1"
    };
    const events = (body: string): Array<Record<string, unknown>> =>
      body
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);

    try {
      const acceptedResponse = await app.inject({
        method: "POST",
        url: "/session/start/stream",
        payload: request
      });
      const acceptedEvents = events(acceptedResponse.body);
      expect(acceptedEvents.map((event) => event.kind)).toEqual(["result", "done"]);
      expect(acceptedEvents[0]).toMatchObject({
        result: {
          details: {
            session: { state: "waiting_input" },
            turnSignals: { inputRequest: { toolName: "AskUserQuestion" } },
            turnReceipt: { turnKey: request.turnKey, state: "accepted" }
          }
        }
      });

      const replayResponse = await app.inject({
        method: "POST",
        url: "/session/start/stream",
        payload: { ...request, lifecycleEpoch: 42 }
      });
      const replayEvents = events(replayResponse.body);
      expect(replayEvents.map((event) => event.kind)).toEqual(["result", "done"]);
      expect(replayEvents[0]).toMatchObject({
        result: {
          details: {
            session: { state: "waiting_input" },
            turnReceipt: { turnKey: request.turnKey, state: "replayed" }
          }
        }
      });

      const activeTurn = app.inject({
        method: "POST",
        url: "/session/daemon-keyed/send/stream",
        payload: { message: "SLOW_TURN newer output", contextFiles: [] }
      });
      const marker = join(workspaceDir, ".fake-acpx-state", "daemon-keyed.slow");
      let markerObserved = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        markerObserved = await readFile(marker, "utf8").then(
          () => true,
          () => false
        );
        if (markerObserved) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(markerObserved).toBe(true);
      const isolatedReplay = await app.inject({
        method: "POST",
        url: "/session/start/stream",
        payload: request
      });
      const isolatedEvents = events(isolatedReplay.body);
      expect(isolatedEvents.map((event) => event.kind)).toEqual(["result", "done"]);
      expect(JSON.stringify(isolatedEvents)).not.toContain("newer output");
      await app.inject({ method: "DELETE", url: "/session/daemon-keyed" });
      await activeTurn;

      const conflictResponse = await app.inject({
        method: "POST",
        url: "/session/start/stream",
        payload: { ...request, task: "Conflicting payload." }
      });
      expect(events(conflictResponse.body)).toEqual([
        expect.objectContaining({
          kind: "error",
          code: "TURN_KEY_CONFLICT",
          details: expect.objectContaining({ turnKey: request.turnKey }) as unknown
        }),
        expect.objectContaining({ kind: "done" })
      ]);
    } finally {
      await app.close();
    }
  });

  it("emits accepted and replayed durable receipts for post-dispatch SSE errors", async () => {
    const workspaceDir = await createTempDir("puppenclaw-daemon-idempotent-error-");
    const missingCommand = join(workspaceDir, "missing-codex-executable");
    const { app } = await createDaemonServer({
      config: makeConfig({
        backend: "daemon",
        agentCommands: { codex: missingCommand }
      }),
      dataDir: workspaceDir
    });
    const request = {
      agent: "codex",
      name: "daemon-keyed-error",
      directory: workspaceDir,
      task: "Fail after active-turn publication.",
      contextFiles: [],
      turnKey: "queue:daemon-error",
      modelProviderId: "openai-test",
      modelProvider: {
        id: "openai-test",
        kind: "codex-openai",
        model: "test-model"
      }
    };
    const parseEvents = (body: string): Array<Record<string, unknown>> =>
      body
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);

    try {
      const accepted = parseEvents(
        (
          await app.inject({
            method: "POST",
            url: "/session/start/stream",
            payload: request
          })
        ).body
      );
      expect(accepted).toEqual([
        expect.objectContaining({
          kind: "error",
          code: "CODEX_TURN_FAILED",
          details: { turnReceipt: { turnKey: request.turnKey, state: "accepted" } }
        }),
        expect.objectContaining({ kind: "done" })
      ]);
      const replayed = parseEvents(
        (
          await app.inject({
            method: "POST",
            url: "/session/start/stream",
            payload: request
          })
        ).body
      );
      expect(replayed).toEqual([
        expect.objectContaining({
          kind: "error",
          code: "CODEX_TURN_FAILED",
          details: { turnReceipt: { turnKey: request.turnKey, state: "replayed" } }
        }),
        expect.objectContaining({ kind: "done" })
      ]);
    } finally {
      await app.close();
    }
  });

  it("redacts credentials from JSON and SSE error boundaries", async () => {
    const workspaceDir = await createTempDir("puppenclaw-daemon-error-redaction-");
    const { app } = await createDaemonServer({
      config: makeConfig({
        backend: "daemon",
        acpxCommand: await resolveFakeAcpxCommand()
      }),
      dataDir: workspaceDir
    });
    const payload = {
      agent: "claude",
      name: "redacted-error",
      directory: workspaceDir,
      task: "SECRET_ERROR",
      contextFiles: [],
      turnKey: "queue:redacted-error"
    };

    try {
      const stream = await app.inject({
        method: "POST",
        url: "/session/start/stream",
        payload
      });
      const json = await app.inject({
        method: "POST",
        url: "/session/start",
        payload
      });
      const status = await app.inject({
        method: "GET",
        url: "/session/redacted-error"
      });
      const persisted = await readFile(join(workspaceDir, "state.json"), "utf8");
      const surfaces = [json.body, stream.body, status.body, persisted];
      for (const body of surfaces) {
        expect(body).not.toContain("bearer-secret");
        expect(body).not.toContain("user:pass");
        expect(body).not.toContain("query-secret");
        expect(body).not.toContain("sk-proj-rawsecret");
        expect(body).not.toContain("raw-token");
        expect(body).not.toContain("sk-proj-anotherraw");
      }
      expect(surfaces.join("\n")).toContain("[redacted]");
      expect(JSON.parse(persisted)).toMatchObject({
        sessions: {
          "redacted-error": {
            activeTurn: { error: expect.stringContaining("[redacted]") as string }
          }
        },
        turnRequests: {
          "redacted-error": {
            "queue:redacted-error": {
              outcome: {
                session: {
                  activeTurn: { error: expect.stringContaining("[redacted]") as string }
                }
              }
            }
          }
        }
      });
    } finally {
      await app.close();
    }
  });
});
