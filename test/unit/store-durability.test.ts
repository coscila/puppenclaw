import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { OutputRouter } from "../../src/plugin/output-router.js";
import { SessionStore } from "../../src/shared/store.js";
import type { ModelProviderSubagentPolicy, SessionInfo } from "../../src/shared/types.js";
import {
  fingerprintSendRequest,
  fingerprintStartRequest
} from "../../src/shared/turn-idempotency.js";
import {
  readJsonFile,
  readJsonFileResilient,
  writeJsonFileAtomic
} from "../../src/shared/utils.js";
import {
  createStoreAndRouter,
  createTempDir,
  makeConfig,
  resolveFakeAcpxCommand
} from "../helpers.js";

async function linuxProcessIdentity(pid: number): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
    if (raw != null) {
      const commandEnd = raw.lastIndexOf(")");
      const fields = raw.slice(commandEnd + 1).trim().split(/\s+/u);
      const startTicks = fields[19];
      if (startTicks != null) {
        return `${pid}:${startTicks}`;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Unable to read process identity for ${pid}.`);
}

function stableLegacyJson(value: unknown): string {
  if (value == null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableLegacyJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableLegacyJson(record[key] ?? null)}`)
    .join(",")}}`;
}

function legacyStartFingerprint(params: {
  agent: "claude" | "codex";
  name: string;
  directory: string;
  task: string;
  contextFiles?: string[];
  skills?: string[];
}): string {
  return createHash("sha256")
    .update(
      stableLegacyJson({
        version: 1,
        operation: "start",
        sessionName: params.name.trim(),
        agent: params.agent,
        directory: resolve(params.directory),
        task: params.task.trim(),
        permissionMode: null,
        interactionMode: null,
        effort: null,
        planningProfile: null,
        model: null,
        modelProviderId: null,
        modelProvider: null,
        contextFiles: (params.contextFiles ?? []).map((entry) => entry.trim()),
        skills: [...new Set((params.skills ?? []).map((entry) => entry.trim()))].sort()
      })
    )
    .digest("hex");
}

describe("writeJsonFileAtomic", () => {
  it("writes durable content and leaves no temporary files behind", async () => {
    const dir = await createTempDir("puppenclaw-durability-write-");
    const path = join(dir, "state.json");

    await writeJsonFileAtomic(path, { version: 1, sessions: {} });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, sessions: {} });
    const entries = await readdir(dir);
    expect(entries).toEqual(["state.json"]);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("overwrites an existing file in place", async () => {
    const dir = await createTempDir("puppenclaw-durability-overwrite-");
    const path = join(dir, "state.json");

    await writeJsonFileAtomic(path, { generation: 1 });
    await writeJsonFileAtomic(path, { generation: 2 });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ generation: 2 });
    expect(await readdir(dir)).toEqual(["state.json"]);
    expect(await readJsonFile(path, null)).toEqual({ generation: 2 });
  });
});

describe("readJsonFileResilient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the fallback without quarantining when the file is missing", async () => {
    const dir = await createTempDir("puppenclaw-durability-enoent-");
    const path = join(dir, "state.json");

    expect(await readJsonFileResilient(path, { fresh: true })).toEqual({ fresh: true });
    expect(await readdir(dir)).toEqual([]);
  });

  it("quarantines a corrupt file and returns the fallback", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = await createTempDir("puppenclaw-durability-corrupt-");
    const path = join(dir, "state.json");
    await writeFile(path, '{"version": 1, "sessions": {"tru', "utf8");

    expect(await readJsonFileResilient(path, { fresh: true })).toEqual({ fresh: true });
    const entries = await readdir(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^state\.json\.corrupt-/u);
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0]?.[0]).toContain(join(dir, entries[0] ?? ""));
  });
});

describe("SessionStore.open", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens corrupt state in recovery-required mode until an explicit reset", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = await createTempDir("puppenclaw-durability-store-corrupt-");
    await writeFile(join(dir, "state.json"), "not json at all", "utf8");

    const store = await SessionStore.open(dir);

    expect(store.listSessions()).toEqual([]);
    expect(store.getRecoveryStatus()).toMatchObject({ required: true, reason: "corrupt" });
    await expect(
      store.upsertSession({
        agent: "claude",
        name: "must-not-reuse",
        directory: dir,
        state: "idle",
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        permissionMode: "approve-reads",
        warnings: [],
        transcript: []
      })
    ).rejects.toMatchObject({ code: "STATE_RECOVERY_REQUIRED" });
    expect((await readdir(dir)).some((entry) => /^state\.json\.corrupt-/u.test(entry))).toBe(true);

    await expect(store.resetRecovery()).resolves.toEqual({ required: false });
    await expect(store.flush()).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8"))).toMatchObject({
      version: 1,
      sessions: {}
    });
    await store.close();
  });

  it.skipIf(process.platform === "win32")(
    "secures an existing state file before exposing the store",
    async () => {
      const dir = await createTempDir("puppenclaw-state-mode-");
      const first = await SessionStore.open(dir);
      await first.flush();
      await first.close();
      const path = join(dir, "state.json");
      await chmod(path, 0o644);

      const reopened = await SessionStore.open(dir);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await reopened.flush();
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await reopened.close();
    }
  );

  it("requires recovery for version-mismatched and structurally invalid state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = await createTempDir("puppenclaw-durability-store-version-");
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({ version: 999, sessions: { legacy: { name: "legacy" } } }),
      "utf8"
    );

    const store = await SessionStore.open(dir);

    expect(store.listSessions()).toEqual([]);
    expect(store.getSession("legacy")).toBeNull();
    expect(store.getRecoveryStatus()).toMatchObject({
      required: true,
      reason: "incompatible"
    });
    await store.close();

    const invalidDir = await createTempDir("puppenclaw-durability-store-invalid-");
    await writeFile(
      join(invalidDir, "state.json"),
      JSON.stringify({
        version: 1,
        sessions: { damaged: { name: "damaged", state: "running" } },
        exposures: {},
        quiescence: { lastEpoch: 0, active: {}, latestByName: {} }
      }),
      "utf8"
    );
    const invalidStore = await SessionStore.open(invalidDir);
    expect(invalidStore.getRecoveryStatus()).toMatchObject({ required: true, reason: "invalid" });
    await invalidStore.close();
  });

  it("requires recovery when persisted namespaces or lifecycle fences are inconsistent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const timestamp = "2026-08-12T00:00:00.000Z";
    const baseState = () => ({
      version: 1,
      sessions: {},
      exposures: {},
      quiescence: { lastEpoch: 0, active: {}, latestByName: {} }
    });
    const session = (name: string) => ({
      agent: "claude",
      name,
      directory: "/tmp/puppenclaw-semantic-state",
      state: "idle",
      createdAt: timestamp,
      lastActivity: timestamp,
      permissionMode: "approve-reads",
      warnings: [],
      transcript: []
    });
    const runningTurn = () => ({
      id: "turn-semantic",
      state: "running",
      startedAt: timestamp,
      updatedAt: timestamp,
      outputChars: 0
    });
    const damagedStates: unknown[] = [];

    damagedStates.push({
      ...baseState(),
      sessions: { expected: session("different") }
    });
    damagedStates.push({
      ...baseState(),
      sessions: {
        expected: {
          ...session("expected"),
          handle: {
            runtimeSessionName: "different",
            cwd: "/tmp/puppenclaw-semantic-state",
            agent: "claude",
            mode: "persistent"
          }
        }
      }
    });
    damagedStates.push({
      ...baseState(),
      sessions: {
        expected: { ...session("expected"), lastActivity: "not-a-timestamp" }
      }
    });
    damagedStates.push({
      ...baseState(),
      sessions: {
        expected: {
          ...session("expected"),
          activeTurn: { ...runningTurn(), completedAt: timestamp }
        }
      }
    });
    damagedStates.push({
      ...baseState(),
      sessions: {
        expected: {
          ...session("expected"),
          activeTurn: { ...runningTurn(), state: "completed" }
        }
      }
    });
    damagedStates.push({
      ...baseState(),
      sessions: {
        expected: {
          ...session("expected"),
          activeTurn: {
            ...runningTurn(),
            startedAt: "2026-08-12T00:00:01.000Z",
            updatedAt: timestamp
          }
        }
      }
    });
    damagedStates.push({
      ...baseState(),
      sessions: {
        expected: {
          ...session("expected"),
          activeTurn: { ...runningTurn(), processGroupId: 1234 }
        }
      }
    });
    damagedStates.push({
      ...baseState(),
      exposures: {
        expected: {
          bindingId: "different",
          conversation: {
            channel: "test",
            accountId: "account",
            conversationId: "conversation"
          },
          allowPurePipe: false,
          allowedAgents: ["claude"],
          mode: "read-only",
          allowedVerbs: [],
          allowedProjectRoots: [],
          updatedAt: timestamp
        }
      }
    });
    damagedStates.push({
      ...baseState(),
      quiescence: {
        lastEpoch: 1,
        active: {
          expected: { name: "different", epoch: 1, purpose: "purge", updatedAt: timestamp }
        },
        latestByName: {}
      }
    });
    damagedStates.push({
      ...baseState(),
      quiescence: {
        lastEpoch: 2,
        active: {
          expected: { name: "expected", epoch: 2, purpose: "external", updatedAt: timestamp }
        },
        latestByName: { expected: 1 }
      }
    });
    damagedStates.push({
      ...baseState(),
      quiescence: {
        lastEpoch: 1,
        active: {},
        latestByName: { expected: 2 }
      }
    });
    damagedStates.push({
      ...baseState(),
      quiescence: {
        lastEpoch: Number.MAX_SAFE_INTEGER + 1,
        active: {},
        latestByName: {}
      }
    });

    for (const [index, damaged] of damagedStates.entries()) {
      const dir = await createTempDir(`puppenclaw-durability-semantic-${index}-`);
      await writeFile(join(dir, "state.json"), JSON.stringify(damaged), "utf8");

      const store = await SessionStore.open(dir);
      expect(store.getRecoveryStatus()).toMatchObject({ required: true, reason: "invalid" });
      expect(store.listSessions()).toEqual([]);
      await expect(store.reserveQuiescence("unsafe-reuse", "external")).rejects.toMatchObject({
        code: "STATE_RECOVERY_REQUIRED"
      });
      await store.close();
    }
  });

  it("refuses to persist a mutation that violates state identity invariants", async () => {
    const dir = await createTempDir("puppenclaw-durability-invalid-mutation-");
    const store = await SessionStore.open(dir);
    const timestamp = new Date().toISOString();
    await store.upsertSession({
      agent: "claude",
      name: "stable-name",
      directory: dir,
      state: "idle",
      createdAt: timestamp,
      lastActivity: timestamp,
      permissionMode: "approve-reads",
      warnings: [],
      transcript: []
    });

    await expect(
      store.patchSession("stable-name", (current) =>
        current == null ? null : { ...current, name: "different-name" }
      )
    ).rejects.toMatchObject({ code: "INVALID_STATE_MUTATION" });
    expect(store.getSession("stable-name")?.name).toBe("stable-name");
    expect(
      JSON.parse(await readFile(join(dir, "state.json"), "utf8")).sessions["stable-name"].name
    ).toBe("stable-name");
    await store.close();
  });

  it("opens with the fallback state when no state file exists", async () => {
    const dir = await createTempDir("puppenclaw-durability-store-fresh-");

    const store = await SessionStore.open(dir);

    expect(store.listSessions()).toEqual([]);
    expect(store.getRecoveryStatus()).toEqual({ required: false });
    expect(await readdir(dir)).toEqual([".state-owner.json"]);
    await store.close();
    expect(await readdir(dir)).toEqual([]);
  });

  it("stays read-only when corrupt state cannot be quarantined", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T01:02:03.004Z"));
    const dir = await createTempDir("puppenclaw-durability-unquarantinable-");
    await writeFile(join(dir, "state.json"), "{broken", "utf8");
    await mkdir(join(dir, "state.json.corrupt-2026-08-12T01-02-03.004Z"));

    const store = await SessionStore.open(dir);

    expect(store.getRecoveryStatus()).toMatchObject({ required: true, reason: "corrupt" });
    expect(await readFile(join(dir, "state.json"), "utf8")).toBe("{broken");
    await expect(store.reserveQuiescence("unsafe", "external")).rejects.toMatchObject({
      code: "STATE_RECOVERY_REQUIRED"
    });
    await store.close();
    vi.useRealTimers();
  });

  it("allows only one live owner and safely takes over a stale owner lease", async () => {
    const dir = await createTempDir("puppenclaw-durability-owner-");
    const owner = await SessionStore.open(dir);

    await expect(SessionStore.open(dir)).rejects.toMatchObject({ code: "STATE_ROOT_IN_USE" });
    await owner.close();

    await writeFile(
      join(dir, ".state-owner.json"),
      JSON.stringify({
        version: 1,
        ownerId: "stale-owner",
        pid: 999_999_999,
        processStartIdentity: "999999999:1",
        acquiredAt: "2026-08-12T00:00:00.000Z"
      }),
      "utf8"
    );
    const replacement = await SessionStore.open(dir);
    expect(replacement.getRecoveryStatus()).toEqual({ required: false });
    expect((await readdir(dir)).some((entry) => entry.startsWith(".state-owner.json.stale-"))).toBe(
      true
    );
    await replacement.close();
  });
});

describe("durable turn requests", () => {
  const timestamp = "2026-08-12T00:00:00.000Z";
  const session = (name: string, directory: string) => ({
    agent: "claude" as const,
    name,
    directory,
    state: "idle" as const,
    createdAt: timestamp,
    lastActivity: timestamp,
    permissionMode: "approve-reads" as const,
    warnings: [],
    transcript: []
  });

  it.skipIf(process.platform === "win32")(
    "keeps the historical no-owner start fingerprint golden",
    () => {
      const request = {
        agent: "claude" as const,
        name: " legacy-golden ",
        directory: "/var/tmp/puppenclaw-legacy-project",
        task: " Preserve this keyed start. ",
        contextFiles: [" context.txt "],
        skills: ["review", "review", "planning"]
      };
      expect(fingerprintStartRequest(request)).toBe(
        "498f615ce5bafc81233788588cd6d15a900dbf0275c5cbe027c18f810aa103f9"
      );
      expect(fingerprintStartRequest(request)).toBe(legacyStartFingerprint(request));
      expect(
        fingerprintStartRequest({ ...request, ownerKey: "owner.account.a.00000001" })
      ).not.toBe(fingerprintStartRequest(request));
      expect(
        fingerprintStartRequest({ ...request, ownerKey: "owner.account.a.00000001" })
      ).not.toBe(
        fingerprintStartRequest({ ...request, ownerKey: "owner.account.b.00000002" })
      );
    }
  );

  describe("model provider subagent policy", () => {
    const modelProvider = {
      id: "remote_qwen38_xhigh",
      label: "Local LLM (xhigh thinking)",
      kind: "codex-openai-compatible" as const,
      model: "chat",
      reasoningProfile: "qwen-3.8" as const,
      baseUrl: "http://127.0.0.1:18160/v1",
      authTokenEnv: "PAISDB_AI_API_KEY",
      wireApi: "responses" as const
    };
    const subagents: ModelProviderSubagentPolicy = {
      model: "chat",
      effort: "xhigh",
      maxConcurrentThreads: 6
    };
    const startRequest = {
      agent: "codex" as const,
      name: " provider-golden ",
      directory: "/var/tmp/puppenclaw-provider-golden",
      task: " Keep this provider start stable. ",
      interactionMode: "plan" as const,
      permissionMode: "approve-reads" as const,
      effort: "xhigh" as const,
      modelProviderId: "remote_qwen38_xhigh",
      modelProvider,
      ownerKey: "owner.account.a.00000001",
      contextFiles: [],
      skills: []
    };
    const sendRequest = {
      name: " provider-golden ",
      message: " Keep this provider refresh stable. ",
      interactionMode: "execute" as const,
      permissionMode: "approve-all" as const,
      effort: "xhigh" as const,
      modelProviderId: "remote_qwen38_xhigh",
      modelProvider,
      contextFiles: []
    };

    it.skipIf(process.platform === "win32")(
      "keeps provider start and send fingerprints golden without a subagent policy",
      () => {
        // Digests recorded before modelProvider.subagents existed. Changing them
        // would make persisted turn keys stop replaying after an upgrade.
        expect(fingerprintStartRequest(startRequest)).toBe(
          "a8c690101f6fbd3dfabbfe8ae10a44235e3311c8a513a96e414c604ce38ff0b9"
        );
        expect(fingerprintSendRequest(sendRequest)).toBe(
          "996a03d6b4cfd4399a9700697c7481d9eca31089226b0e0f86e67791d1b16093"
        );
      }
    );

    it("binds every subagent policy field into provider fingerprints", () => {
      const withPolicy = (policy: ModelProviderSubagentPolicy) => ({
        start: fingerprintStartRequest({
          ...startRequest,
          modelProvider: { ...modelProvider, subagents: policy }
        }),
        send: fingerprintSendRequest({
          ...sendRequest,
          modelProvider: { ...modelProvider, subagents: policy }
        })
      });
      const base = withPolicy(subagents);
      expect(base.start).not.toBe(fingerprintStartRequest(startRequest));
      expect(base.send).not.toBe(fingerprintSendRequest(sendRequest));
      expect(withPolicy({ ...subagents })).toEqual(base);
      for (const variant of [
        { ...subagents, model: "chat-2" },
        { ...subagents, effort: "high" as const },
        { ...subagents, maxConcurrentThreads: 7 }
      ]) {
        const changed = withPolicy(variant);
        expect(changed.start).not.toBe(base.start);
        expect(changed.send).not.toBe(base.send);
      }
    });

    it("persists a subagent policy with the session across a store restart", async () => {
      const dir = await createTempDir("puppenclaw-subagent-policy-persist-");
      const first = await SessionStore.open(dir);
      await first.upsertSession({
        ...session("subagent-policy", dir),
        agent: "codex",
        model: "gpt-6-sol",
        modelProviderId: "remote_langdock_gpt6_sol_medium",
        modelProvider: {
          id: "remote_langdock_gpt6_sol_medium",
          kind: "codex-openai-compatible",
          model: "gpt-6-sol",
          baseUrl: "http://127.0.0.1:18161/v1",
          authTokenEnv: "LANGDOCK_API_KEY",
          wireApi: "responses",
          subagents
        }
      });
      await first.close();

      const reopened = await SessionStore.open(dir);
      try {
        expect(reopened.getRecoveryStatus()).toEqual({ required: false });
        expect(reopened.getSession("subagent-policy")?.modelProvider).toEqual({
          id: "remote_langdock_gpt6_sol_medium",
          kind: "codex-openai-compatible",
          model: "gpt-6-sol",
          baseUrl: "http://127.0.0.1:18161/v1",
          authTokenEnv: "LANGDOCK_API_KEY",
          wireApi: "responses",
          subagents
        });
      } finally {
        await reopened.close();
      }
    });
  });

  it("replays a seeded pre-owner start receipt after a store restart", async () => {
    const workspaceDir = await createTempDir("puppenclaw-legacy-start-replay-");
    const request = {
      agent: "claude" as const,
      name: "legacy-start-replay",
      directory: workspaceDir,
      task: "Do not dispatch this historical request again.",
      contextFiles: [],
      turnKey: "legacy:start:replay"
    };
    const legacyFingerprint = legacyStartFingerprint(request);
    expect(fingerprintStartRequest(request)).toBe(legacyFingerprint);

    const first = await SessionStore.open(workspaceDir);
    await first.claimTurnRequest({
      sessionName: request.name,
      turnKey: request.turnKey,
      operation: "start",
      requestFingerprint: legacyFingerprint
    });
    await first.close();

    const reopened = await SessionStore.open(workspaceDir);
    try {
      const manager = new AcpxSessionManager({
        config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        store: reopened,
        outputRouter: new OutputRouter({
          info() {},
          warn() {},
          error() {},
          debug() {}
        })
      });
      await manager.reconcilePersistedSessions();
      await expect(manager.start(request)).rejects.toMatchObject({
        code: "TURN_INTERRUPTED_RESTART",
        details: { turnReceipt: { state: "replayed" } }
      });
    } finally {
      await reopened.close();
    }
  });

  it("bounds full replay outcomes without ever making an old key executable", async () => {
    const dir = await createTempDir("puppenclaw-turn-retention-");
    const seededReceipts = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => {
        const turnKey = `turn-${String(index).padStart(2, "0")}`;
        const fingerprint = index.toString(16).padStart(64, "0");
        const completedAt = new Date(Date.parse(timestamp) + index * 1_000).toISOString();
        const activeTurn = {
          id: `active-${index}`,
          turnKey,
          requestFingerprint: fingerprint,
          state: "completed",
          startedAt: timestamp,
          updatedAt: completedAt,
          completedAt,
          outputChars: 0
        };
        return [
          turnKey,
          {
            sessionName: "retained",
            turnKey,
            operation: "send",
            requestFingerprint: fingerprint,
            state: "settled",
            acceptedAt: timestamp,
            updatedAt: completedAt,
            completedAt,
            activeTurnId: activeTurn.id,
            outcome: {
              version: 1,
              kind: "success",
              summary: "Seeded retained turn.",
              session: {
                name: "retained",
                state: "idle",
                lastActivity: completedAt,
                activeTurn
              },
              output: `output-${index}`,
              outputRole: "assistant",
              contextFiles: []
            }
          }
        ];
      })
    );
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({
        version: 1,
        sessions: { retained: session("retained", dir) },
        turnRequests: { retained: seededReceipts },
        turnGenerations: {},
        exposures: {},
        quiescence: { lastEpoch: 0, active: {}, latestByName: {} }
      }),
      "utf8"
    );
    const store = await SessionStore.open(dir);
    const turnKey = "turn-64";
    const fingerprint = "40".padStart(64, "0");
    await store.claimTurnRequest({
      sessionName: "retained",
      turnKey,
      operation: "send",
      requestFingerprint: fingerprint
    });
    await store.patchSessionAndLinkTurnRequest("retained", turnKey, fingerprint, (current) => ({
      ...(current ?? session("retained", dir)),
      state: "running",
      activeTurn: {
        id: "active-64",
        turnKey,
        requestFingerprint: fingerprint,
        state: "running",
        startedAt: timestamp,
        updatedAt: timestamp,
        outputChars: 0
      }
    }));
    await store.patchSessionAndSettleTurnRequest(
      "retained",
      turnKey,
      fingerprint,
      (current) => ({
        ...(current ?? session("retained", dir)),
        state: "idle",
        activeTurn: {
          ...(current?.activeTurn as NonNullable<SessionInfo["activeTurn"]>),
          state: "completed",
          updatedAt: timestamp,
          completedAt: timestamp
        }
      }),
      {
        version: 1,
        kind: "success",
        summary: "Completed retained turn.",
        output: `${"x".repeat(200_100)} ordinary https://example.test/docs secret https://user:pass@example.test/path?token=abc&view=full`,
        outputRole: "assistant",
        contextFiles: [{ path: "context.txt", bytes: 10, truncated: false }]
      }
    );

    expect(store.getTurnRequest("retained", "turn-00")?.state).toBe("tombstone");
    expect(store.getTurnRequest("retained", "turn-00")?.outcome).toBeUndefined();
    expect(store.getTurnRequest("retained", "turn-01")?.state).toBe("settled");
    const newest = store.getTurnRequest("retained", "turn-64");
    expect(newest?.outcome?.kind).toBe("success");
    if (newest?.outcome?.kind === "success") {
      expect(newest.outcome.output.length).toBeLessThanOrEqual(200_000);
      expect(newest.outcome.output).toMatch(/^\[replay output truncated:/u);
      expect(newest.outcome.output).toContain("https://example.test/docs");
      expect(newest.outcome.output).not.toContain("user:pass");
      expect(newest.outcome.output).not.toContain("token=abc");
      expect(newest.outcome.output).toContain("token=[redacted]");
    }
    await expect(
      store.claimTurnRequest({
        sessionName: "retained",
        turnKey: "turn-00",
        operation: "send",
        requestFingerprint: "0".repeat(64)
      })
    ).rejects.toMatchObject({ code: "TURN_KEY_ALREADY_CLAIMED" });
    await store.close();
  });

  it("fails closed on a malformed successful receipt snapshot", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = await createTempDir("puppenclaw-turn-invalid-");
    const store = await SessionStore.open(dir);
    await store.upsertSession(session("damaged", dir));
    const fingerprint = "a".repeat(64);
    await store.claimTurnRequest({
      sessionName: "damaged",
      turnKey: "damaged-key",
      operation: "send",
      requestFingerprint: fingerprint
    });
    await store.patchSessionAndLinkTurnRequest("damaged", "damaged-key", fingerprint, (current) => ({
      ...(current ?? session("damaged", dir)),
      state: "running",
      activeTurn: {
        id: "active-damaged",
        turnKey: "damaged-key",
        requestFingerprint: fingerprint,
        state: "running",
        startedAt: timestamp,
        updatedAt: timestamp,
        outputChars: 0
      }
    }));
    await store.patchSessionAndSettleTurnRequest(
      "damaged",
      "damaged-key",
      fingerprint,
      (current) => ({
        ...(current ?? session("damaged", dir)),
        state: "idle",
        activeTurn: {
          ...(current?.activeTurn as NonNullable<SessionInfo["activeTurn"]>),
          state: "completed",
          updatedAt: timestamp,
          completedAt: timestamp
        }
      }),
      {
        version: 1,
        kind: "success",
        summary: "Done.",
        output: "done",
        outputRole: "assistant",
        contextFiles: []
      }
    );
    await store.close();

    const path = join(dir, "state.json");
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      turnRequests: Record<string, Record<string, { outcome: { session: { state: string } } }>>;
    };
    raw.turnRequests["damaged"]!["damaged-key"]!.outcome.session.state = "running";
    await writeFile(path, JSON.stringify(raw), "utf8");
    const reopened = await SessionStore.open(dir);
    expect(reopened.getRecoveryStatus()).toMatchObject({ required: true, reason: "invalid" });
    await reopened.close();
  });

  it("fails closed on a running receipt with a dangling active-turn link", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = await createTempDir("puppenclaw-turn-dangling-");
    const store = await SessionStore.open(dir);
    await store.upsertSession(session("dangling", dir));
    const fingerprint = "b".repeat(64);
    await store.claimTurnRequest({
      sessionName: "dangling",
      turnKey: "dangling-key",
      operation: "send",
      requestFingerprint: fingerprint
    });
    await store.patchSessionAndLinkTurnRequest(
      "dangling",
      "dangling-key",
      fingerprint,
      (current) => ({
        ...(current ?? session("dangling", dir)),
        state: "running",
        activeTurn: {
          id: "active-linked",
          turnKey: "dangling-key",
          requestFingerprint: fingerprint,
          state: "running",
          startedAt: timestamp,
          updatedAt: timestamp,
          outputChars: 0
        }
      })
    );
    await store.close();
    const path = join(dir, "state.json");
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      sessions: Record<string, { activeTurn: { id: string } }>;
    };
    raw.sessions["dangling"]!.activeTurn.id = "different-active-turn";
    await writeFile(path, JSON.stringify(raw), "utf8");

    const reopened = await SessionStore.open(dir);
    expect(reopened.getRecoveryStatus()).toMatchObject({ required: true, reason: "invalid" });
    await reopened.close();
  });
});

describe("startup reconciliation", () => {
  const silentLogger = {
    info() {},
    warn() {},
    error() {},
    debug() {}
  };

  it("settles a receipt-only crash as a replayable interruption", async () => {
    const workspaceDir = await createTempDir("puppenclaw-receipt-only-restart-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const request = {
      agent: "claude" as const,
      name: "receipt-only",
      directory: workspaceDir,
      task: "Do not relaunch after a lost claim response.",
      contextFiles: [],
      turnKey: "queue:receipt-only"
    };
    const fingerprint = fingerprintStartRequest(request);
    await store.claimTurnRequest({
      sessionName: request.name,
      turnKey: request.turnKey,
      operation: "start",
      requestFingerprint: fingerprint
    });
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger: silentLogger,
      store,
      outputRouter
    });

    await manager.reconcilePersistedSessions();

    expect(store.getTurnRequest(request.name, request.turnKey)).toMatchObject({
      state: "settled",
      outcome: { kind: "error", code: "TURN_INTERRUPTED_RESTART" }
    });
    await expect(manager.start(request)).rejects.toMatchObject({
      code: "TURN_INTERRUPTED_RESTART",
      details: { turnReceipt: { turnKey: request.turnKey, state: "replayed" } }
    });
  });

  it("atomically settles a keyed active turn whose recorded process is dead", async () => {
    const workspaceDir = await createTempDir("puppenclaw-keyed-dead-restart-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const timestamp = new Date().toISOString();
    const request = {
      name: "keyed-dead",
      message: "Never run this twice.",
      contextFiles: [],
      turnKey: "queue:keyed-dead"
    };
    const fingerprint = fingerprintSendRequest(request);
    await store.upsertSession({
      agent: "claude",
      name: request.name,
      directory: workspaceDir,
      state: "idle",
      createdAt: timestamp,
      lastActivity: timestamp,
      permissionMode: "approve-reads",
      warnings: [],
      transcript: []
    });
    await store.claimTurnRequest({
      sessionName: request.name,
      turnKey: request.turnKey,
      operation: "send",
      requestFingerprint: fingerprint
    });
    await store.patchSessionAndLinkTurnRequest(
      request.name,
      request.turnKey,
      fingerprint,
      (current) => ({
        ...(current as NonNullable<typeof current>),
        state: "running",
        activeTurn: {
          id: "turn-keyed-dead",
          turnKey: request.turnKey,
          requestFingerprint: fingerprint,
          state: "running",
          startedAt: timestamp,
          updatedAt: timestamp,
          pid: 999_999_999,
          processStartIdentity: "999999999:0",
          outputChars: 0
        }
      })
    );
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger: silentLogger,
      store,
      outputRouter
    });

    await manager.reconcilePersistedSessions();

    expect(store.getSession(request.name)).toMatchObject({
      state: "failed",
      activeTurn: { state: "orphaned" }
    });
    expect(store.getTurnRequest(request.name, request.turnKey)).toMatchObject({
      state: "settled",
      outcome: { kind: "error", code: "TURN_INTERRUPTED_RESTART" }
    });
    await expect(manager.send(request)).rejects.toMatchObject({
      code: "TURN_INTERRUPTED_RESTART",
      details: { turnReceipt: { state: "replayed" } }
    });
  });

  it("marks a persisted running session with a dead turn process as failed", async () => {
    const workspaceDir = await createTempDir("puppenclaw-durability-startup-sweep-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const timestamp = new Date().toISOString();
    await store.upsertSession({
      agent: "claude",
      name: "dead-turn",
      directory: workspaceDir,
      state: "running",
      createdAt: timestamp,
      lastActivity: timestamp,
      permissionMode: "approve-reads",
      warnings: [],
      transcript: [],
      activeTurn: {
        id: "turn-dead",
        state: "running",
        startedAt: timestamp,
        updatedAt: timestamp,
        pid: 999_999_999,
        processStartIdentity: "999999999:0",
        outputChars: 0
      }
    });

    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger: silentLogger,
      store,
      outputRouter
    });
    await manager.reconcilePersistedSessions();

    const session = store.getSession("dead-turn");
    expect(session?.state).toBe("failed");
    expect(session?.activeTurn?.state).toBe("orphaned");
    expect(session?.lastStopReason).toBe("Interrupted by daemon restart");
    expect(
      JSON.parse(await readFile(join(workspaceDir, "state.json"), "utf8"))
    ).toMatchObject({ sessions: { "dead-turn": { state: "failed" } } });
  });

  it("keeps ordinary idle sessions untouched and adds a survivor fence behind quiescence", async () => {
    const workspaceDir = await createTempDir("puppenclaw-durability-startup-skip-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const timestamp = new Date().toISOString();
    await store.upsertSession({
      agent: "claude",
      name: "idle-session",
      directory: workspaceDir,
      state: "idle",
      createdAt: timestamp,
      lastActivity: timestamp,
      permissionMode: "approve-reads",
      warnings: [],
      transcript: []
    });
    await store.upsertSession({
      agent: "claude",
      name: "fenced-session",
      directory: workspaceDir,
      state: "running",
      createdAt: timestamp,
      lastActivity: timestamp,
      permissionMode: "approve-reads",
      warnings: [],
      transcript: []
    });
    await store.reserveQuiescence("fenced-session", "external");

    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger: silentLogger,
      store,
      outputRouter
    });
    await manager.reconcilePersistedSessions();

    expect(store.getSession("idle-session")?.state).toBe("idle");
    expect(store.getSession("fenced-session")).toMatchObject({
      state: "running",
      recoveryFence: { reason: "missing-turn-metadata" }
    });
  });

  it("fences a running record without active-turn metadata until Stop proves closure", async () => {
    const workspaceDir = await createTempDir("puppenclaw-durability-missing-turn-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const timestamp = new Date().toISOString();
    await store.upsertSession({
      agent: "claude",
      name: "missing-turn",
      directory: workspaceDir,
      state: "running",
      createdAt: timestamp,
      lastActivity: timestamp,
      permissionMode: "approve-reads",
      warnings: [],
      transcript: []
    });
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger: silentLogger,
      store,
      outputRouter
    });

    await manager.reconcilePersistedSessions();

    expect(store.getSession("missing-turn")?.recoveryFence).toMatchObject({
      reason: "missing-turn-metadata"
    });
    await expect(
      manager.send({ name: "missing-turn", message: "Must remain fenced.", contextFiles: [] })
    ).rejects.toMatchObject({ code: "RECOVERY_FENCE_ACTIVE" });
    await expect(manager.stop({ name: "missing-turn" })).resolves.toMatchObject({
      details: { session: { state: "stopped" } }
    });
    expect(store.getSession("missing-turn")?.recoveryFence).toBeUndefined();
  });

  it.skipIf(process.platform !== "linux")(
    "persists and terminates a restart-surviving detached turn before allowing reuse",
    async () => {
      const workspaceDir = await createTempDir("puppenclaw-durability-live-turn-");
      const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore"
      });
      if (child.pid == null) {
        throw new Error("Detached test process has no PID.");
      }
      const pid = child.pid;
      child.unref();
      try {
        const timestamp = new Date().toISOString();
        const processStartIdentity = await linuxProcessIdentity(pid);
        await store.upsertSession({
          agent: "codex",
          name: "survivor",
          directory: workspaceDir,
          state: "running",
          createdAt: timestamp,
          lastActivity: timestamp,
          permissionMode: "approve-reads",
          model: "test-model",
          modelProviderId: "test-provider",
          modelProvider: {
            id: "test-provider",
            kind: "codex-openai",
            model: "test-model"
          },
          warnings: [],
          transcript: [],
          activeTurn: {
            id: "turn-survivor",
            state: "running",
            startedAt: timestamp,
            updatedAt: timestamp,
            pid,
            processGroupId: 999_999_998,
            processStartIdentity,
            outputChars: 0
          },
          recoveryFence: {
            reason: "restart-survivor",
            detectedAt: timestamp,
            pid,
            processGroupId: 999_999_998,
            processStartIdentity
          }
        });
        const manager = new AcpxSessionManager({
          config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
          logger: silentLogger,
          store,
          outputRouter
        });

        await manager.reconcilePersistedSessions();

        expect(store.getSession("survivor")?.recoveryFence).toMatchObject({
          reason: "restart-survivor",
          pid,
          processGroupId: 999_999_998,
          processStartIdentity
        });
        await expect(
          manager.send({ name: "survivor", message: "Must not overlap.", contextFiles: [] })
        ).rejects.toMatchObject({ code: "RECOVERY_FENCE_ACTIVE" });
        await manager.stop({ name: "survivor" });
        expect(store.getSession("survivor")).toMatchObject({
          state: "stopped",
          activeTurn: { state: "stopped" }
        });
        expect(store.getSession("survivor")?.recoveryFence).toBeUndefined();
        await expect(readFile(`/proc/${pid}/stat`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // The expected Stop path already terminated the detached group.
        }
      }
    }
  );

  it.skipIf(process.platform !== "linux")(
    "fences a live persisted turn even when its workflow state says idle",
    async () => {
      const workspaceDir = await createTempDir("puppenclaw-durability-idle-live-turn-");
      const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore"
      });
      if (child.pid == null) {
        throw new Error("Detached test process has no PID.");
      }
      const pid = child.pid;
      child.unref();
      try {
        const timestamp = new Date().toISOString();
        const processStartIdentity = await linuxProcessIdentity(pid);
        await store.upsertSession({
          agent: "codex",
          name: "idle-survivor",
          directory: workspaceDir,
          state: "idle",
          createdAt: timestamp,
          lastActivity: timestamp,
          permissionMode: "approve-reads",
          model: "test-model",
          modelProviderId: "test-provider",
          modelProvider: {
            id: "test-provider",
            kind: "codex-openai",
            model: "test-model"
          },
          warnings: [],
          transcript: [],
          activeTurn: {
            id: "turn-idle-survivor",
            state: "running",
            startedAt: timestamp,
            updatedAt: timestamp,
            pid,
            processGroupId: pid,
            processStartIdentity,
            outputChars: 0
          }
        });
        const manager = new AcpxSessionManager({
          config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
          logger: silentLogger,
          store,
          outputRouter
        });

        await manager.reconcilePersistedSessions();

        expect(store.getSession("idle-survivor")).toMatchObject({
          state: "idle",
          activeTurn: { state: "running", pid },
          recoveryFence: { reason: "restart-survivor", pid }
        });
        await expect(
          manager.send({ name: "idle-survivor", message: "Must remain fenced.", contextFiles: [] })
        ).rejects.toMatchObject({ code: "RECOVERY_FENCE_ACTIVE" });
        await manager.stop({ name: "idle-survivor" });
        expect(store.getSession("idle-survivor")).toMatchObject({
          state: "stopped",
          activeTurn: { state: "stopped" }
        });
        await expect(readFile(`/proc/${pid}/stat`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // The expected Stop path already terminated the detached group.
        }
      }
    }
  );
});
