import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { activeTurnCheckpointMs } from "../../src/manager/acpx.js";
import { SessionStore } from "../../src/shared/store.js";
import type { SessionInfo } from "../../src/shared/types.js";
import { createTempDir } from "../helpers.js";

function session(name: string, directory = "/workspace"): SessionInfo {
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
    transcript: []
  };
}

async function persisted(dir: string): Promise<{ sessions: Record<string, SessionInfo> }> {
  return JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as {
    sessions: Record<string, SessionInfo>;
  };
}

describe("SessionStore group commit", () => {
  it("writes a burst of concurrent mutations once and resolves each after that write", async () => {
    const dir = await createTempDir("puppenclaw-group-burst-");
    const store = await SessionStore.open(dir);
    try {
      await Promise.all(
        Array.from({ length: 25 }, (_, index) => store.upsertSession(session(`burst-${index}`)))
      );
      expect(store.persistenceStats()).toMatchObject({ writes: 1, mutations: 25, batches: 1, fallbacks: 0, largestBatch: 25 });
      expect(Object.keys((await persisted(dir)).sessions)).toHaveLength(25);
      expect(store.pendingMutationCount).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("keeps awaited mutations as separate writes and applies batched ones in call order", async () => {
    const dir = await createTempDir("puppenclaw-group-order-");
    const store = await SessionStore.open(dir);
    try {
      await store.upsertSession(session("ordered"));
      await store.patchSession("ordered", (current) => ({ ...current!, warnings: ["awaited"] }));
      expect(store.persistenceStats().writes).toBe(2);

      const appended = await Promise.all(
        ["one", "two", "three"].map((warning) =>
          store.patchSession("ordered", (current) => ({ ...current!, warnings: [...current!.warnings, warning] }))
        )
      );
      expect(appended.map((value) => value?.warnings)).toEqual([
        ["awaited", "one"],
        ["awaited", "one", "two"],
        ["awaited", "one", "two", "three"]
      ]);
      expect(store.persistenceStats().writes).toBe(3);
      expect((await persisted(dir)).sessions.ordered?.warnings).toEqual(["awaited", "one", "two", "three"]);
    } finally {
      await store.close();
    }
  });

  it("falls back to per-mutation writes when one mutator rejects, isolating only that caller", async () => {
    const dir = await createTempDir("puppenclaw-group-reject-");
    const store = await SessionStore.open(dir);
    try {
      await store.upsertSession(session("fenced"));
      const results = await Promise.allSettled([
        store.reserveQuiescence("fenced", "external"),
        store.patchSession("fenced", (current) => ({ ...current!, warnings: ["must not land"] })),
        store.upsertSession(session("unrelated"))
      ]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
      expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: "SESSION_QUIESCED" });
      expect(store.persistenceStats().fallbacks).toBe(1);
      expect(store.getQuiescence("fenced")?.epoch).toBe(1);
      expect(store.getSession("fenced")?.warnings).toEqual([]);
      expect(store.getSession("unrelated")).not.toBeNull();
      const onDisk = await persisted(dir);
      expect(onDisk.sessions.fenced?.warnings).toEqual([]);
      expect(onDisk.sessions.unrelated).toBeDefined();
    } finally {
      await store.close();
    }
  });

  it("rejects only the mutation that would make the batch invalid", async () => {
    const dir = await createTempDir("puppenclaw-group-invalid-");
    const store = await SessionStore.open(dir);
    try {
      await store.upsertSession(session("valid"));
      const results = await Promise.allSettled([
        store.patchSession("valid", (current) => ({ ...current!, warnings: ["kept"] })),
        store.patchSession("valid", (current) => ({ ...current!, state: "bogus" as SessionInfo["state"] })),
        store.upsertSession(session("also-valid"))
      ]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
      expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: "INVALID_STATE_MUTATION" });
      expect(store.getSession("valid")?.warnings).toEqual(["kept"]);
      expect(store.getSession("valid")?.state).toBe("idle");
      expect(store.getSession("also-valid")).not.toBeNull();
    } finally {
      await store.close();
    }
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "leaves memory and disk unchanged when the batch write fails, then recovers",
    async () => {
      const dir = await createTempDir("puppenclaw-group-write-failure-");
      const store = await SessionStore.open(dir);
      try {
        await store.upsertSession(session("before"));
        await chmod(dir, 0o500);
        const failed = await Promise.allSettled([
          store.upsertSession(session("lost-1")),
          store.upsertSession(session("lost-2"))
        ]);
        await chmod(dir, 0o700);
        expect(failed.map((result) => result.status)).toEqual(["rejected", "rejected"]);
        expect(store.getSession("lost-1")).toBeNull();
        expect(store.getSession("lost-2")).toBeNull();
        expect(store.persistenceStats().fallbacks).toBe(1);

        await store.upsertSession(session("after"));
        expect(Object.keys((await persisted(dir)).sessions).sort()).toEqual(["after", "before"]);
      } finally {
        await chmod(dir, 0o700);
        await store.close();
      }
    }
  );

  it("flushes queued mutations before close completes", async () => {
    const dir = await createTempDir("puppenclaw-group-close-");
    const store = await SessionStore.open(dir);
    const pending = store.upsertSession(session("closing"));
    await store.close();
    await pending;
    expect((await persisted(dir)).sessions.closing).toBeDefined();
    await expect(store.upsertSession(session("late"))).rejects.toMatchObject({ code: "STATE_STORE_CLOSED" });
  });
});

describe("active-turn checkpoint interval", () => {
  it("defaults to 30 s and accepts an override with a floor", () => {
    expect(activeTurnCheckpointMs({})).toBe(30_000);
    expect(activeTurnCheckpointMs({ PUPPENCLAW_ACTIVE_TURN_CHECKPOINT_MS: "5000" })).toBe(5_000);
    expect(activeTurnCheckpointMs({ PUPPENCLAW_ACTIVE_TURN_CHECKPOINT_MS: "10" })).toBe(250);
    expect(activeTurnCheckpointMs({ PUPPENCLAW_ACTIVE_TURN_CHECKPOINT_MS: "soon" })).toBe(30_000);
  });
});
