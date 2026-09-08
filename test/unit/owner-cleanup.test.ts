import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDaemonServer } from "../../src/daemon/server.js";
import { SessionStore } from "../../src/shared/store.js";
import type { SessionInfo } from "../../src/shared/types.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

const OWNER_A = "owner.account.a.00000001";
const OWNER_B = "owner.account.b.00000002";
const OPERATION_A = "delete.account.a.000001";

function storedSession(name: string, directory: string): SessionInfo {
  const timestamp = new Date().toISOString();
  return {
    agent: "claude",
    name,
    directory,
    state: "idle",
    createdAt: timestamp,
    lastActivity: timestamp,
    permissionMode: "approve-reads",
    warnings: [],
    transcript: []
  };
}

describe("account-scoped daemon cleanup", () => {
  it("hydrates owner defaults from pre-owner state and persists later mutations", async () => {
    const dataDir = await createTempDir("puppenclaw-owner-legacy-upgrade-");
    const legacyName = "legacy-before-owner-scopes";
    await writeFile(
      join(dataDir, "state.json"),
      `${JSON.stringify(
        {
          version: 1,
          sessions: { [legacyName]: storedSession(legacyName, dataDir) },
          turnRequests: {},
          turnGenerations: {},
          exposures: {},
          quiescence: { lastEpoch: 0, active: {}, latestByName: {} }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    let store = await SessionStore.open(dataDir);
    try {
      expect(store.getSessionOwner(legacyName)).toBeNull();
      expect(store.listSessionsByOwner(OWNER_A)).toEqual([]);
      expect(store.getOwnerCleanup(OWNER_A)).toBeNull();
      await store.upsertSession(storedSession("owned-after-upgrade", dataDir), OWNER_A);
    } finally {
      await store.close();
    }

    store = await SessionStore.open(dataDir);
    try {
      expect(store.getSessionOwner(legacyName)).toBeNull();
      expect(store.getSessionOwner("owned-after-upgrade")).toBe(OWNER_A);
      await store.reserveOwnerCleanup(OWNER_B, "delete.account.b.legacy.0001");
    } finally {
      await store.close();
    }

    store = await SessionStore.open(dataDir);
    try {
      expect(store.getOwnerCleanup(OWNER_B)).toMatchObject({
        operationKey: "delete.account.b.legacy.0001",
        state: "quiesced"
      });
    } finally {
      await store.close();
    }
  });

  it("serializes authoritative adoption against racing starts", async () => {
    const dataDir = await createTempDir("puppenclaw-owner-adopt-race-");
    const store = await SessionStore.open(dataDir);

    try {
      const absentName = "racing-legacy-absent";
      const [cleanupFirst, legacyStart] = await Promise.allSettled([
        store.reserveOwnerCleanup(OWNER_A, OPERATION_A, [absentName]),
        store.upsertSession(storedSession(absentName, dataDir))
      ]);
      expect(cleanupFirst).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ code: "OWNER_ADOPTION_UNPROVEN" })
      });
      expect(legacyStart).toMatchObject({ status: "fulfilled" });
      expect(store.getOwnerCleanup(OWNER_A)).toBeNull();
      expect(store.getSessionOwner(absentName)).toBeNull();

      await store.reserveOwnerCleanup(OWNER_A, OPERATION_A, [absentName]);
      expect(store.getSessionOwner(absentName)).toBe(OWNER_A);

      const fencedName = "racing-owned-after-fence";
      const [fence, ownedStart] = await Promise.allSettled([
        store.reserveOwnerCleanup(OWNER_B, "delete.account.b.000002"),
        store.upsertSession(storedSession(fencedName, dataDir), OWNER_B)
      ]);
      expect(fence).toMatchObject({ status: "fulfilled" });
      expect(ownedStart).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ code: "OWNER_SCOPE_QUIESCED" })
      });
      expect(store.getSession(fencedName)).toBeNull();
    } finally {
      await store.close();
    }
  });

  it("requires daemon bearer authentication for owner selectors", async () => {
    const dataDir = await createTempDir("puppenclaw-owner-auth-");
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      dataDir
    });

    try {
      const capabilities = await app.inject({
        method: "GET",
        url: "/capabilities"
      });
      expect(capabilities.statusCode).toBe(200);
      expect(JSON.parse(capabilities.body)).not.toHaveProperty("sessionOwnerCleanup");

      const listed = await app.inject({
        method: "POST",
        url: "/sessions/owner/list",
        payload: { ownerKey: OWNER_A }
      });
      expect(listed.statusCode).toBe(503);
      expect(JSON.parse(listed.body)).toMatchObject({
        code: "DAEMON_AUTH_REQUIRED"
      });

      const ownedStart = await app.inject({
        method: "POST",
        url: "/session/start",
        payload: {
          agent: "claude",
          name: "owner-auth-required",
          directory: dataDir,
          task: "This start must be rejected.",
          ownerKey: OWNER_A,
          contextFiles: []
        }
      });
      expect(ownedStart.statusCode).toBe(503);
      expect(JSON.parse(ownedStart.body)).toMatchObject({ code: "DAEMON_AUTH_REQUIRED" });
    } finally {
      await app.close();
    }
  });

  it("adopts legacy sessions, fences starts, and purges idempotently without revealing keys", async () => {
    const dataDir = await createTempDir("puppenclaw-owner-cleanup-");
    const authToken = "daemon-owner-cleanup-token";
    const config = makeConfig({
      acpxCommand: await resolveFakeAcpxCommand(),
      daemonAuthToken: authToken
    });
    const authorization = `Bearer ${authToken}`;
    let server = await createDaemonServer({ config, dataDir });

    const start = async (name: string, ownerKey?: string) =>
      await server.app.inject({
        method: "POST",
        url: "/session/start",
        headers: { authorization },
        payload: {
          agent: "claude",
          name,
          directory: dataDir,
          task: `Start ${name}.`,
          ...(ownerKey != null ? { ownerKey } : {}),
          contextFiles: []
        }
      });

    try {
      expect((await start("owned-a", OWNER_A)).statusCode).toBe(200);
      expect((await start("legacy-a")).statusCode).toBe(200);
      expect((await start("owned-b", OWNER_B)).statusCode).toBe(200);
      expect((await start("unowned-legacy")).statusCode).toBe(200);

      const beforeAdoption = await server.app.inject({
        method: "POST",
        url: "/sessions/owner/list",
        headers: { authorization },
        payload: { ownerKey: OWNER_A }
      });
      expect(JSON.parse(beforeAdoption.body).sessions).toEqual([
        expect.objectContaining({ name: "owned-a" })
      ]);

      const quiesced = await server.app.inject({
        method: "POST",
        url: "/sessions/owner/quiesce",
        headers: { authorization },
        payload: {
          ownerKey: OWNER_A,
          operationKey: OPERATION_A,
          sessionNames: ["legacy-a"]
        }
      });
      expect(quiesced.statusCode).toBe(200);
      expect(JSON.parse(quiesced.body)).toMatchObject({
        ok: true,
        adopted: 1,
        quiesced: 2,
        cleanup: { state: "quiesced" }
      });
      expect(quiesced.body).not.toContain(OWNER_A);
      expect(quiesced.body).not.toContain(OPERATION_A);

      const blockedStart = await start("owned-a-after-fence", OWNER_A);
      expect(blockedStart.statusCode).toBe(409);
      expect(JSON.parse(blockedStart.body)).toMatchObject({ code: "OWNER_SCOPE_QUIESCED" });

      const purged = await server.app.inject({
        method: "POST",
        url: "/sessions/owner/purge",
        headers: { authorization },
        payload: {
          ownerKey: OWNER_A,
          operationKey: OPERATION_A,
          sessionNames: ["legacy-a"]
        }
      });
      expect(purged.statusCode).toBe(200);
      expect(JSON.parse(purged.body)).toMatchObject({
        ok: true,
        adopted: 1,
        purged: 2,
        sessions: [],
        cleanup: { state: "purged" }
      });
      expect(purged.body).not.toContain(OWNER_A);
      expect(purged.body).not.toContain(OPERATION_A);

      const retried = await server.app.inject({
        method: "POST",
        url: "/sessions/owner/purge",
        headers: { authorization },
        payload: {
          ownerKey: OWNER_A,
          operationKey: OPERATION_A,
          sessionNames: ["legacy-a"]
        }
      });
      expect(retried.statusCode).toBe(200);
      expect(JSON.parse(retried.body)).toMatchObject({
        purged: 0,
        cleanup: { state: "purged" }
      });

      const competing = await server.app.inject({
        method: "POST",
        url: "/sessions/owner/purge",
        headers: { authorization },
        payload: {
          ownerKey: OWNER_A,
          operationKey: "different.cleanup.00002",
          sessionNames: ["legacy-a"]
        }
      });
      expect(competing.statusCode).toBe(409);
      expect(JSON.parse(competing.body)).toMatchObject({ code: "OWNER_CLEANUP_CONFLICT" });

      for (const survivingName of ["owned-b", "unowned-legacy"]) {
        const status = await server.app.inject({
          method: "GET",
          url: `/session/${survivingName}`,
          headers: { authorization }
        });
        expect(status.statusCode).toBe(200);
      }

      await server.app.close();
      server = await createDaemonServer({ config, dataDir });
      const restartBlocked = await start("owned-a-after-restart", OWNER_A);
      expect(restartBlocked.statusCode).toBe(409);
      expect(JSON.parse(restartBlocked.body)).toMatchObject({ code: "OWNER_SCOPE_QUIESCED" });
    } finally {
      await server.app.close();
    }
  });

  it("rejects an unprovable or conflicting legacy adoption without a partial fence", async () => {
    const dataDir = await createTempDir("puppenclaw-owner-adoption-");
    const authToken = "daemon-owner-adoption-token";
    const authorization = `Bearer ${authToken}`;
    const { app } = await createDaemonServer({
      config: makeConfig({
        acpxCommand: await resolveFakeAcpxCommand(),
        daemonAuthToken: authToken
      }),
      dataDir
    });

    try {
      const missing = await app.inject({
        method: "POST",
        url: "/sessions/owner/quiesce",
        headers: { authorization },
        payload: {
          ownerKey: OWNER_A,
          operationKey: OPERATION_A,
          sessionNames: ["not-present"]
        }
      });
      expect(missing.statusCode).toBe(409);
      expect(JSON.parse(missing.body)).toMatchObject({ code: "OWNER_ADOPTION_UNPROVEN" });

      const startAfterRejectedAdoption = await app.inject({
        method: "POST",
        url: "/session/start",
        headers: { authorization },
        payload: {
          agent: "claude",
          name: "after-rejected-adoption",
          directory: dataDir,
          task: "This owner scope must remain usable.",
          ownerKey: OWNER_A,
          contextFiles: []
        }
      });
      expect(startAfterRejectedAdoption.statusCode).toBe(200);

      const conflict = await app.inject({
        method: "POST",
        url: "/sessions/owner/quiesce",
        headers: { authorization },
        payload: {
          ownerKey: OWNER_B,
          operationKey: "delete.account.b.000002",
          sessionNames: ["after-rejected-adoption"]
        }
      });
      expect(conflict.statusCode).toBe(409);
      expect(JSON.parse(conflict.body)).toMatchObject({ code: "SESSION_OWNER_CONFLICT" });
    } finally {
      await app.close();
    }
  });

  it("retains the owner fence and reports recovery when a runner cannot yet be closed", async () => {
    const dataDir = await createTempDir("puppenclaw-owner-recovery-");
    const authToken = "daemon-owner-recovery-token";
    const authorization = `Bearer ${authToken}`;
    const { app } = await createDaemonServer({
      config: makeConfig({
        acpxCommand: await resolveFakeAcpxCommand(),
        daemonAuthToken: authToken
      }),
      dataDir
    });

    try {
      const started = await app.inject({
        method: "POST",
        url: "/session/start",
        headers: { authorization },
        payload: {
          agent: "claude",
          name: "retry-close",
          directory: dataDir,
          task: "Create a runtime whose first close attempt fails.",
          ownerKey: OWNER_A,
          contextFiles: []
        }
      });
      expect(started.statusCode).toBe(200);

      const first = await app.inject({
        method: "POST",
        url: "/sessions/owner/quiesce",
        headers: { authorization },
        payload: { ownerKey: OWNER_A, operationKey: OPERATION_A }
      });
      expect(first.statusCode).toBe(503);
      expect(JSON.parse(first.body)).toMatchObject({
        code: "OWNER_CLEANUP_INCOMPLETE",
        details: {
          stage: "quiesce",
          matched: 1,
          recoveryRequired: true,
          causeCode: "QUIESCENCE_UNAVAILABLE"
        }
      });
      expect(first.body).not.toContain(OWNER_A);
      expect(first.body).not.toContain(OPERATION_A);

      const blocked = await app.inject({
        method: "POST",
        url: "/session/start",
        headers: { authorization },
        payload: {
          agent: "claude",
          name: "blocked-during-owner-recovery",
          directory: dataDir,
          task: "This must not run.",
          ownerKey: OWNER_A,
          contextFiles: []
        }
      });
      expect(blocked.statusCode).toBe(409);
      expect(JSON.parse(blocked.body)).toMatchObject({ code: "OWNER_SCOPE_QUIESCED" });

      const retried = await app.inject({
        method: "POST",
        url: "/sessions/owner/quiesce",
        headers: { authorization },
        payload: { ownerKey: OWNER_A, operationKey: OPERATION_A }
      });
      expect(retried.statusCode).toBe(200);
      expect(JSON.parse(retried.body)).toMatchObject({ cleanup: { state: "quiesced" } });
    } finally {
      await app.close();
    }
  }, 10000);
});
