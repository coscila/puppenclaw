import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDaemonServer } from "../../src/daemon/server.js";
import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { PuppenclawError } from "../../src/shared/errors.js";
import { SessionStore } from "../../src/shared/store.js";
import type { ToolResult } from "../../src/shared/types.js";
import {
  createStoreAndRouter,
  createTempDir,
  makeConfig,
  resolveFakeAcpxCommand
} from "../helpers.js";

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
};

function quiescenceDetails(result: ToolResult): {
  quiescenceEpoch: number;
  runtimeClosed: boolean;
  reservation: { name: string; epoch: number };
} {
  return result.details as {
    quiescenceEpoch: number;
    runtimeClosed: boolean;
    reservation: { name: string; epoch: number };
  };
}

function sseDataEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n\n")
    .flatMap((block) => {
      const data = block
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length);
      return data != null ? [JSON.parse(data) as Record<string, unknown>] : [];
    });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      await access(path)
        .then(() => true)
        .catch(() => false)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

describe("session quiescence", () => {
  it("persists monotonic epochs and idempotent release across manager restarts", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-persist-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const firstState = await createStoreAndRouter(workspaceDir);
    const firstManager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger,
      store: firstState.store,
      outputRouter: firstState.outputRouter
    });

    await firstManager.start({
      agent: "claude",
      name: "durable",
      directory: workspaceDir,
      task: "Prime the durable session.",
      contextFiles: []
    });
    const first = quiescenceDetails(await firstManager.quiesce({ name: "durable" }));
    expect(first).toMatchObject({
      quiescenceEpoch: 1,
      runtimeClosed: true,
      reservation: { name: "durable", epoch: 1 }
    });
    await expect(
      firstManager.send({
        name: "durable",
        message: "Do not run.",
        contextFiles: []
      })
    ).rejects.toMatchObject({ code: "SESSION_QUIESCED" });

    await firstState.store.close();
    const reopenedStore = await SessionStore.open(workspaceDir);
    const reopenedState = await createStoreAndRouter(await createTempDir("puppenclaw-router-"));
    const reopenedManager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger,
      store: reopenedStore,
      outputRouter: reopenedState.outputRouter
    });
    const repeated = quiescenceDetails(await reopenedManager.quiesce({ name: "durable" }));
    expect(repeated.quiescenceEpoch).toBe(1);

    await reopenedManager.purge({ name: "durable" });
    expect(reopenedStore.getSession("durable")).toBeNull();
    await expect(reopenedManager.purge({ name: "durable" })).rejects.toMatchObject({
      code: "NO_SESSION"
    });
    expect(reopenedStore.getActiveQuiescenceEpoch("durable")).toBe(1);
    const afterPurge = quiescenceDetails(await reopenedManager.quiesce({ name: "durable" }));
    expect(afterPurge.quiescenceEpoch).toBe(1);

    const released = await reopenedManager.releaseQuiescence({
      name: "durable",
      epoch: 1
    });
    expect(released.details).toMatchObject({
      released: true,
      quiescenceEpoch: 1,
      reservation: { name: "durable", epoch: 1 }
    });
    await expect(
      reopenedManager.releaseQuiescence({ name: "durable", epoch: 1 })
    ).resolves.toMatchObject({
      details: { released: true, quiescenceEpoch: 1 }
    });
    await expect(
      reopenedManager.releaseQuiescence({ name: "durable", epoch: 2 })
    ).rejects.toMatchObject({ code: "STALE_QUIESCENCE_EPOCH" });

    await reopenedManager.start({
      agent: "claude",
      name: "durable",
      directory: workspaceDir,
      task: "Start again after release.",
      lifecycleEpoch: 1,
      contextFiles: []
    });
    const next = quiescenceDetails(await reopenedManager.quiesce({ name: "durable" }));
    expect(next.quiescenceEpoch).toBe(2);
    await reopenedManager.purge({ name: "durable" });
    await reopenedManager.releaseQuiescence({ name: "durable", epoch: 2 });

    const persisted = JSON.parse(await readFile(join(workspaceDir, "state.json"), "utf8")) as {
      quiescence: {
        lastEpoch: number;
        active: Record<string, unknown>;
        latestByName: Record<string, number>;
      };
    };
    expect(persisted.quiescence).toEqual({
      lastEpoch: 2,
      active: {},
      latestByName: { durable: 2 }
    });
  });

  it("retains per-name lifecycle history alongside globally monotonic epochs", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-bounded-");
    const store = await SessionStore.open(workspaceDir);

    for (let index = 0; index < 25; index += 1) {
      const name = `one-shot-${index}`;
      const reservation = await store.reserveQuiescence(name, "external");
      await store.releaseQuiescence(name, reservation.epoch);
    }

    const persisted = JSON.parse(await readFile(join(workspaceDir, "state.json"), "utf8")) as {
      quiescence: {
        lastEpoch: number;
        active: Record<string, unknown>;
        latestByName: Record<string, number>;
      };
    };
    expect(persisted.quiescence.lastEpoch).toBe(25);
    expect(persisted.quiescence.active).toEqual({});
    expect(persisted.quiescence.latestByName).toEqual(
      Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`one-shot-${index}`, index + 1]))
    );
    await expect(store.releaseQuiescence("one-shot-0", 1)).resolves.toMatchObject({
      name: "one-shot-0",
      epoch: 1
    });
    await expect(store.releaseQuiescence("one-shot-0", 26)).rejects.toMatchObject({
      code: "STALE_QUIESCENCE_EPOCH"
    });

    const newer = await store.reserveQuiescence("one-shot-0", "external");
    expect(newer.epoch).toBe(26);
    await expect(store.releaseQuiescence("one-shot-0", 1)).rejects.toMatchObject({
      code: "STALE_QUIESCENCE_EPOCH"
    });
    expect(store.getActiveQuiescenceEpoch("one-shot-0")).toBe(26);
    await store.releaseQuiescence("one-shot-0", 26);
  });

  it("keeps internal purge fences transient and permits ordinary same-name reuse", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-transient-purge-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger,
      store,
      outputRouter
    });

    await manager.start({
      agent: "claude",
      name: "reusable-one-shot",
      directory: workspaceDir,
      task: "Prime an ordinary session without lifecycle history.",
      contextFiles: []
    });
    await manager.purge({ name: "reusable-one-shot" });
    expect(store.getActiveQuiescenceEpoch("reusable-one-shot")).toBeNull();
    expect(store.getLatestLifecycleEpoch("reusable-one-shot")).toBeNull();

    await expect(
      manager.start({
        agent: "claude",
        name: "reusable-one-shot",
        directory: workspaceDir,
        task: "Reuse the ordinary name without an external stop epoch.",
        contextFiles: []
      })
    ).resolves.toMatchObject({ details: { session: { name: "reusable-one-shot" } } });
    await expect(
      manager.send({
        name: "reusable-one-shot",
        message: "Continue without a lifecycle epoch.",
        contextFiles: []
      })
    ).resolves.toMatchObject({ details: { session: { name: "reusable-one-shot" } } });

    for (let index = 0; index < 20; index += 1) {
      const reservation = await store.reserveQuiescence(`transient-${index}`, "purge");
      await store.releaseQuiescence(`transient-${index}`, reservation.epoch);
    }
    const interrupted = await store.reserveQuiescence("interrupted-purge", "purge");
    await store.close();
    const reopened = await SessionStore.open(workspaceDir);
    expect(reopened.getActiveQuiescenceEpoch("interrupted-purge")).toBe(interrupted.epoch);
    expect(reopened.getLatestLifecycleEpoch("interrupted-purge")).toBeNull();
    await expect(reopened.enterLifecycleTurn("interrupted-purge")).rejects.toMatchObject({
      code: "SESSION_QUIESCED"
    });
    await reopened.releaseQuiescence("interrupted-purge", interrupted.epoch);
    await expect(reopened.enterLifecycleTurn("interrupted-purge")).resolves.toEqual({
      lifecycleEpoch: null,
      releasedQuiescence: false
    });
    const persisted = JSON.parse(await readFile(join(workspaceDir, "state.json"), "utf8")) as {
      quiescence: { latestByName: Record<string, number> };
    };
    expect(persisted.quiescence.latestByName).toEqual({});
  });

  it("promotes a restart-surviving purge fence when an external caller quiesces it", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-promote-purge-");
    const firstStore = await SessionStore.open(workspaceDir);
    const transient = await firstStore.reserveQuiescence("interrupted-purge", "purge");

    await firstStore.close();
    const reopenedStore = await SessionStore.open(workspaceDir);
    const reopenedState = await createStoreAndRouter(await createTempDir("puppenclaw-router-"));
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger,
      store: reopenedStore,
      outputRouter: reopenedState.outputRouter
    });

    const external = quiescenceDetails(
      await manager.quiesce({ name: "interrupted-purge" })
    );
    expect(external).toMatchObject({
      quiescenceEpoch: transient.epoch,
      runtimeClosed: true
    });
    expect(reopenedStore.getQuiescence("interrupted-purge")).toMatchObject({
      epoch: transient.epoch,
      purpose: "external"
    });
    expect(reopenedStore.getLatestLifecycleEpoch("interrupted-purge")).toBe(transient.epoch);

    await expect(
      manager.start({
        agent: "claude",
        name: "interrupted-purge",
        directory: workspaceDir,
        task: "Resume from the externally adopted fence.",
        lifecycleEpoch: transient.epoch,
        contextFiles: []
      })
    ).resolves.toMatchObject({ details: { session: { name: "interrupted-purge" } } });
  });

  it("upgrades legacy active external fences without losing lifecycle history", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-upgrade-");
    await writeFile(
      join(workspaceDir, "state.json"),
      JSON.stringify({
        version: 1,
        sessions: {},
        exposures: {},
        quiescence: {
          lastEpoch: 7,
          active: {
            legacy: {
              name: "legacy",
              epoch: 7,
              purpose: "external",
              updatedAt: "2026-01-01T00:00:00.000Z"
            }
          }
        }
      }),
      "utf8"
    );

    const upgraded = await SessionStore.open(workspaceDir);
    expect(upgraded.getLatestLifecycleEpoch("legacy")).toBe(7);
    await upgraded.releaseQuiescence("legacy", 7);

    await upgraded.close();
    const reopened = await SessionStore.open(workspaceDir);
    expect(reopened.getLatestLifecycleEpoch("legacy")).toBe(7);
    await expect(reopened.enterLifecycleTurn("legacy")).rejects.toMatchObject({
      code: "LIFECYCLE_EPOCH_REQUIRED"
    });
    await expect(reopened.enterLifecycleTurn("legacy", 7)).resolves.toEqual({
      lifecycleEpoch: 7,
      releasedQuiescence: false
    });
  });

  it("keeps TTL garbage collection compatible with same-name start and send", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-transient-gc-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand, sessionTtlMinutes: 1 }),
      logger,
      store,
      outputRouter
    });
    const staleActivity = new Date(Date.now() - 10 * 60_000).toISOString();
    await store.upsertSession({
      agent: "claude",
      name: "gc-reusable",
      directory: workspaceDir,
      state: "completed",
      createdAt: staleActivity,
      lastActivity: staleActivity,
      permissionMode: "approve-reads",
      warnings: [],
      transcript: []
    });

    await manager.gc();
    expect(store.getSession("gc-reusable")).toBeNull();
    expect(store.getLatestLifecycleEpoch("gc-reusable")).toBeNull();
    await manager.start({
      agent: "claude",
      name: "gc-reusable",
      directory: workspaceDir,
      task: "Reuse the TTL-reaped session name.",
      contextFiles: []
    });
    await expect(
      manager.send({
        name: "gc-reusable",
        message: "Continue the reused session without an epoch.",
        contextFiles: []
      })
    ).resolves.toMatchObject({ details: { session: { name: "gc-reusable" } } });
  });

  it("fails closed when a restarted manager cannot prove direct one-shot process closure", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-orphan-proof-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const timestamp = new Date().toISOString();
    await store.upsertSession({
      agent: "codex",
      name: "unowned-one-shot",
      directory: workspaceDir,
      state: "running",
      createdAt: timestamp,
      lastActivity: timestamp,
      permissionMode: "approve-reads",
      modelProvider: {
        id: "restart-test",
        kind: "codex-openai-compatible",
        model: "fake-model"
      },
      warnings: [],
      transcript: []
    });
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger,
      store,
      outputRouter
    });

    await expect(manager.quiesce({ name: "unowned-one-shot" })).rejects.toMatchObject({
      code: "QUIESCENCE_UNAVAILABLE"
    });
    expect(store.getActiveQuiescenceEpoch("unowned-one-shot")).toBe(1);
    expect(store.getSession("unowned-one-shot")?.state).toBe("running");
  });

  it("serializes resume through final persistence before proving quiescence", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-resume-race-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger,
      store,
      outputRouter
    });
    await manager.start({
      agent: "claude",
      name: "resume-race",
      directory: workspaceDir,
      task: "Prime the resumable session.",
      contextFiles: []
    });
    await manager.suspend({ name: "resume-race" });

    const originalUpsert = store.upsertSession.bind(store);
    let unblockResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      unblockResume = resolve;
    });
    let signalResumePersistence!: () => void;
    const resumePersistenceEntered = new Promise<void>((resolve) => {
      signalResumePersistence = resolve;
    });
    let holdResumePersistence = true;
    store.upsertSession = async (session) => {
      if (session.name === "resume-race" && session.state === "idle" && holdResumePersistence) {
        holdResumePersistence = false;
        signalResumePersistence();
        await resumeGate;
      }
      await originalUpsert(session);
    };

    const resumeOutcome = manager.resume({ name: "resume-race" });
    await resumePersistenceEntered;
    let quiesceFinished = false;
    const quiesceOutcome = manager.quiesce({ name: "resume-race" }).then((result) => {
      quiesceFinished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(quiesceFinished).toBe(false);
    expect(store.getActiveQuiescenceEpoch("resume-race")).toBeNull();

    unblockResume();
    await resumeOutcome;
    const proof = quiescenceDetails(await quiesceOutcome);
    expect(proof.runtimeClosed).toBe(true);
    await manager.releaseQuiescence({ name: "resume-race", epoch: proof.quiescenceEpoch });
    expect((await manager.status({ name: "resume-race" })).details).toMatchObject({
      session: {
        state: "stopped",
        lastStopReason: `quiesced at lifecycle epoch ${proof.quiescenceEpoch}`
      },
      runtime: { exists: false }
    });
  });

  it("releases source lifecycle ownership after snapshotting a fork", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-fork-race-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger,
      store,
      outputRouter
    });
    await manager.start({
      agent: "claude",
      name: "fork-source",
      directory: workspaceDir,
      task: "Prime the fork source.",
      contextFiles: []
    });

    const originalUpsert = store.upsertSession.bind(store);
    let unblockFork!: () => void;
    const forkGate = new Promise<void>((resolve) => {
      unblockFork = resolve;
    });
    let signalForkPersistence!: () => void;
    const forkPersistenceEntered = new Promise<void>((resolve) => {
      signalForkPersistence = resolve;
    });
    let holdForkPersistence = true;
    store.upsertSession = async (session) => {
      if (session.name === "fork-target" && session.state === "running" && holdForkPersistence) {
        holdForkPersistence = false;
        signalForkPersistence();
        await forkGate;
      }
      await originalUpsert(session);
    };

    const forkOutcome = manager.fork({ source: "fork-source", target: "fork-target" });
    await forkPersistenceEntered;
    let quiesceFinished = false;
    const quiesceOutcome = manager.quiesce({ name: "fork-source" }).then((result) => {
      quiesceFinished = true;
      return result;
    });
    const proof = quiescenceDetails(
      await Promise.race([
        quiesceOutcome,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("Source quiescence remained blocked by the fork target turn.")),
            1_000
          ).unref();
        })
      ])
    );
    expect(quiesceFinished).toBe(true);
    expect(store.getActiveQuiescenceEpoch("fork-source")).toBe(proof.quiescenceEpoch);

    unblockFork();
    await forkOutcome;
    expect(proof.runtimeClosed).toBe(true);
    expect(store.getSession("fork-target")).not.toBeNull();
  });

  it("transiently purges an initial start before it can publish a session", async () => {
    const workspaceDir = await createTempDir("puppenclaw-purge-first-start-race-");
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      logger,
      store,
      outputRouter
    });
    const originalUpsert = store.upsertSession.bind(store);
    let unblockUpsert!: () => void;
    const upsertGate = new Promise<void>((resolve) => {
      unblockUpsert = resolve;
    });
    let signalUpsert!: () => void;
    const upsertEntered = new Promise<void>((resolve) => {
      signalUpsert = resolve;
    });
    let holdFirstUpsert = true;
    store.upsertSession = async (session) => {
      if (session.name === "purged-first-start" && holdFirstUpsert) {
        holdFirstUpsert = false;
        signalUpsert();
        await upsertGate;
      }
      await originalUpsert(session);
    };

    const startOutcome = manager
      .start({
        agent: "claude",
        name: "purged-first-start",
        directory: workspaceDir,
        task: "This first start must be transiently purged.",
        contextFiles: []
      })
      .then(
        () => null,
        (error: unknown) => error
      );
    await upsertEntered;
    const purgeOutcome = manager.purge({ name: "purged-first-start" });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (store.getActiveQuiescenceEpoch("purged-first-start") != null) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(store.getActiveQuiescenceEpoch("purged-first-start")).toBe(1);

    unblockUpsert();
    await expect(startOutcome).resolves.toMatchObject({ code: "SESSION_QUIESCED" });
    await expect(purgeOutcome).resolves.toMatchObject({
      details: { purged: true, transientFence: true }
    });
    expect(store.getSession("purged-first-start")).toBeNull();
    expect(store.getActiveQuiescenceEpoch("purged-first-start")).toBeNull();
    expect(store.getLatestLifecycleEpoch("purged-first-start")).toBeNull();
  });

  it("does not return an unknown-name fence until a racing first start drains", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-first-start-race-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger,
      store,
      outputRouter
    });
    const originalUpsert = store.upsertSession.bind(store);
    let unblockUpsert!: () => void;
    const upsertGate = new Promise<void>((resolve) => {
      unblockUpsert = resolve;
    });
    let signalUpsert!: () => void;
    const upsertEntered = new Promise<void>((resolve) => {
      signalUpsert = resolve;
    });
    let holdFirstUpsert = true;
    store.upsertSession = async (session) => {
      if (session.name === "racing-first-start" && holdFirstUpsert) {
        holdFirstUpsert = false;
        signalUpsert();
        await upsertGate;
      }
      await originalUpsert(session);
    };

    const startOutcome = manager
      .start({
        agent: "claude",
        name: "racing-first-start",
        directory: workspaceDir,
        task: "This first start pauses before publishing its session.",
        contextFiles: []
      })
      .then(
        () => null,
        (error: unknown) => error
      );
    await upsertEntered;

    let quiesceFinished = false;
    const quiesceOutcome = manager.quiesce({ name: "racing-first-start" }).then((result) => {
      quiesceFinished = true;
      return result;
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (store.getActiveQuiescenceEpoch("racing-first-start") != null) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(store.getActiveQuiescenceEpoch("racing-first-start")).toBe(1);
    expect(quiesceFinished).toBe(false);

    unblockUpsert();
    await expect(startOutcome).resolves.toMatchObject({ code: "SESSION_QUIESCED" });
    expect(quiescenceDetails(await quiesceOutcome)).toMatchObject({
      quiescenceEpoch: 1,
      runtimeClosed: true
    });
    expect(store.getSession("racing-first-start")).toBeNull();
  });

  it("fences unknown names durably and resumes only at the current epoch", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-unknown-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const firstState = await createStoreAndRouter(workspaceDir);
    const firstManager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger,
      store: firstState.store,
      outputRouter: firstState.outputRouter
    });

    const proof = quiescenceDetails(await firstManager.quiesce({ name: "not-started-yet" }));
    expect(proof).toMatchObject({
      quiescenceEpoch: 1,
      runtimeClosed: true,
      reservation: { name: "not-started-yet", epoch: 1 }
    });
    await expect(
      firstManager.start({
        agent: "claude",
        name: "not-started-yet",
        directory: workspaceDir,
        task: "A dispatch without the stop proof must remain fenced.",
        contextFiles: []
      })
    ).rejects.toMatchObject({ code: "SESSION_QUIESCED" });

    await firstState.store.close();
    const reopenedStore = await SessionStore.open(workspaceDir);
    const reopenedState = await createStoreAndRouter(await createTempDir("puppenclaw-router-"));
    const reopenedManager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger,
      store: reopenedStore,
      outputRouter: reopenedState.outputRouter
    });
    await expect(
      reopenedManager.start({
        agent: "claude",
        name: "not-started-yet",
        directory: workspaceDir,
        task: "A stale dispatch must not cross the durable stop fence.",
        lifecycleEpoch: 2,
        contextFiles: []
      })
    ).rejects.toMatchObject({ code: "STALE_LIFECYCLE_EPOCH" });
    await expect(
      reopenedManager.start({
        agent: "claude",
        name: "not-started-yet",
        directory: workspaceDir,
        task: "Resume with the exact durable stop proof.",
        lifecycleEpoch: 1,
        contextFiles: []
      })
    ).resolves.toMatchObject({
      details: { session: { name: "not-started-yet" } }
    });
    expect(reopenedStore.getActiveQuiescenceEpoch("not-started-yet")).toBeNull();
    expect(reopenedStore.getLatestLifecycleEpoch("not-started-yet")).toBe(1);
    await expect(
      reopenedManager.send({
        name: "not-started-yet",
        message: "History means an epoch remains mandatory after release.",
        contextFiles: []
      })
    ).rejects.toMatchObject({ code: "LIFECYCLE_EPOCH_REQUIRED" });
    await expect(
      reopenedManager.send({
        name: "not-started-yet",
        message: "The current epoch remains authorized after release.",
        lifecycleEpoch: 1,
        contextFiles: []
      })
    ).resolves.toMatchObject({ details: { session: { name: "not-started-yet" } } });

    const secondStop = quiescenceDetails(
      await reopenedManager.quiesce({ name: "not-started-yet" })
    );
    expect(secondStop.quiescenceEpoch).toBe(2);
    await expect(
      reopenedManager.send({
        name: "not-started-yet",
        message: "This delayed dispatch predates the latest stop.",
        lifecycleEpoch: 1,
        contextFiles: []
      })
    ).rejects.toMatchObject({ code: "STALE_LIFECYCLE_EPOCH" });
    await expect(
      reopenedManager.send({
        name: "not-started-yet",
        message: "Resume after the latest stop with its exact epoch.",
        lifecycleEpoch: 2,
        contextFiles: []
      })
    ).resolves.toMatchObject({ details: { session: { name: "not-started-yet" } } });
  });

  it("reports an existing quiesced session as stopped without probing its runtime", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-status-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger,
      store,
      outputRouter
    });
    await manager.start({
      agent: "claude",
      name: "visible-fence",
      directory: workspaceDir,
      task: "Prime the status session.",
      contextFiles: []
    });
    await manager.quiesce({ name: "visible-fence" });

    const status = await manager.status({ name: "visible-fence" });
    expect(status.details).toMatchObject({
      session: {
        name: "visible-fence",
        state: "stopped",
        lastStopReason: "quiesced at lifecycle epoch 1"
      },
      runtime: { exists: false, status: "quiesced" },
      lifecycle: { quiesced: true, epoch: 1 }
    });
  });

  it("drains an in-flight turn and prevents it from resurrecting a purged session", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-race-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger,
      store,
      outputRouter
    });

    await manager.start({
      agent: "claude",
      name: "racing",
      directory: workspaceDir,
      task: "Prime the racing session.",
      contextFiles: []
    });
    const sendOutcome = manager
      .send({ name: "racing", message: "SLOW_TURN", contextFiles: [] })
      .then(
        () => null,
        (error: unknown) => error
      );
    await waitForFile(join(workspaceDir, ".fake-acpx-state", "racing.slow"));

    const proof = quiescenceDetails(await manager.quiesce({ name: "racing" }));
    expect(proof.runtimeClosed).toBe(true);
    const sendError = await sendOutcome;
    expect(sendError).toBeInstanceOf(PuppenclawError);
    expect(sendError).toMatchObject({ code: "SESSION_QUIESCED" });

    await manager.purge({ name: "racing" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(store.getSession("racing")).toBeNull();
    expect(store.getActiveQuiescenceEpoch("racing")).toBe(proof.quiescenceEpoch);
    await manager.releaseQuiescence({
      name: "racing",
      epoch: proof.quiescenceEpoch
    });
    expect(store.getSession("racing")).toBeNull();
  });

  it("fences an ambiguous initial start before it can publish a session result", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-start-race-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger,
      store,
      outputRouter
    });

    const startOutcome = manager
      .start({
        agent: "claude",
        name: "ambiguous-start",
        directory: workspaceDir,
        task: "SLOW_TURN",
        contextFiles: []
      })
      .then(
        () => null,
        (error: unknown) => error
      );
    await waitForFile(join(workspaceDir, ".fake-acpx-state", "ambiguous-start.slow"));

    const proof = quiescenceDetails(await manager.quiesce({ name: "ambiguous-start" }));
    expect(proof.runtimeClosed).toBe(true);
    expect(await startOutcome).toMatchObject({ code: "SESSION_QUIESCED" });
    await manager.purge({ name: "ambiguous-start" });
    await manager.releaseQuiescence({
      name: "ambiguous-start",
      epoch: proof.quiescenceEpoch
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(store.getSession("ambiguous-start")).toBeNull();
    await expect(
      access(join(workspaceDir, ".fake-acpx-state", "ambiguous-start.session"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the same fence when runtime closure must be retried", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-close-retry-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger,
      store,
      outputRouter
    });

    await manager.start({
      agent: "claude",
      name: "retry-close",
      directory: workspaceDir,
      task: "Prime the retry session.",
      contextFiles: []
    });
    await expect(manager.quiesce({ name: "retry-close" })).rejects.toMatchObject({
      code: "QUIESCENCE_UNAVAILABLE"
    });
    expect(store.getActiveQuiescenceEpoch("retry-close")).toBe(1);

    const retried = quiescenceDetails(await manager.quiesce({ name: "retry-close" }));
    expect(retried).toMatchObject({ quiescenceEpoch: 1, runtimeClosed: true });
    await manager.purge({ name: "retry-close" });
    await manager.releaseQuiescence({ name: "retry-close", epoch: 1 });
    expect(store.getActiveQuiescenceEpoch("retry-close")).toBeNull();
  }, 10000);

  it("exposes authenticated daemon proofs and exact typed lifecycle errors", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-http-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand, daemonAuthToken: "secret-token" }),
      dataDir: workspaceDir,
      logger
    });
    const auth = { authorization: "Bearer secret-token" };

    try {
      const unknownFence = await app.inject({
        method: "POST",
        url: "/session/not-created/quiesce",
        headers: auth,
        payload: {}
      });
      expect(unknownFence.statusCode).toBe(200);
      expect(JSON.parse(unknownFence.body)).toMatchObject({
        details: {
          quiescenceEpoch: 1,
          runtimeClosed: true,
          reservation: { name: "not-created", epoch: 1 }
        }
      });
      const unknownDispatch = await app.inject({
        method: "POST",
        url: "/session/start",
        headers: auth,
        payload: {
          agent: "claude",
          name: "not-created",
          directory: workspaceDir,
          task: "A missing epoch cannot cross an unknown-session fence.",
          contextFiles: []
        }
      });
      expect(unknownDispatch.statusCode).toBe(409);
      expect(JSON.parse(unknownDispatch.body)).toMatchObject({
        ok: false,
        code: "SESSION_QUIESCED"
      });

      const missing = await app.inject({
        method: "POST",
        url: "/session/missing/purge",
        headers: auth
      });
      expect(missing.statusCode).toBe(404);
      expect(JSON.parse(missing.body)).toMatchObject({
        ok: false,
        code: "NO_SESSION",
        error: "Unknown session missing.",
        details: { name: "missing", transientFence: true }
      });

      const started = await app.inject({
        method: "POST",
        url: "/session/start",
        headers: auth,
        payload: {
          agent: "claude",
          name: "http-session",
          directory: workspaceDir,
          task: "Prime the HTTP session.",
          contextFiles: []
        }
      });
      expect(started.statusCode).toBe(200);

      const unauthorized = await app.inject({
        method: "POST",
        url: "/session/http-session/quiesce",
        payload: {}
      });
      expect(unauthorized.statusCode).toBe(401);

      const quiesced = await app.inject({
        method: "POST",
        url: "/session/http-session/quiesce",
        headers: auth,
        payload: {}
      });
      expect(quiesced.statusCode).toBe(200);
      const quiescedBody = JSON.parse(quiesced.body) as {
        details: { quiescenceEpoch: number; runtimeClosed: boolean };
      };
      expect(quiescedBody.details).toMatchObject({
        quiescenceEpoch: 2,
        runtimeClosed: true
      });

      const fenced = await app.inject({
        method: "POST",
        url: "/session/http-session/send",
        headers: auth,
        payload: { message: "This must not execute.", contextFiles: [] }
      });
      expect(fenced.statusCode).toBe(409);
      expect(JSON.parse(fenced.body)).toMatchObject({
        ok: false,
        code: "SESSION_QUIESCED"
      });

      const staleRelease = await app.inject({
        method: "POST",
        url: "/session/http-session/quiesce/release",
        headers: auth,
        payload: { epoch: 3 }
      });
      expect(staleRelease.statusCode).toBe(409);
      expect(JSON.parse(staleRelease.body)).toMatchObject({
        ok: false,
        code: "STALE_QUIESCENCE_EPOCH"
      });

      const released = await app.inject({
        method: "POST",
        url: "/session/http-session/quiesce/release",
        headers: auth,
        payload: { epoch: 2 }
      });
      expect(released.statusCode).toBe(200);
      expect(JSON.parse(released.body)).toMatchObject({
        details: { released: true, quiescenceEpoch: 2 }
      });
      const repeatedRelease = await app.inject({
        method: "POST",
        url: "/session/http-session/quiesce/release",
        headers: auth,
        payload: { epoch: 2 }
      });
      expect(repeatedRelease.statusCode).toBe(200);

      const missingEpoch = await app.inject({
        method: "POST",
        url: "/session/http-session/send",
        headers: auth,
        payload: { message: "History remains fenced after release.", contextFiles: [] }
      });
      expect(missingEpoch.statusCode).toBe(409);
      expect(JSON.parse(missingEpoch.body)).toMatchObject({
        ok: false,
        code: "LIFECYCLE_EPOCH_REQUIRED",
        details: { requestedEpoch: null, latestEpoch: 2 }
      });

      const authorized = await app.inject({
        method: "POST",
        url: "/session/http-session/send",
        headers: auth,
        payload: {
          message: "The matching lifecycle epoch authorizes this turn.",
          lifecycleEpoch: 2,
          contextFiles: []
        }
      });
      expect(authorized.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("preserves lifecycle epochs and typed errors across start and send streams", async () => {
    const workspaceDir = await createTempDir("puppenclaw-quiescence-stream-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand, daemonAuthToken: "secret-token" }),
      dataDir: workspaceDir,
      logger
    });
    const auth = { authorization: "Bearer secret-token" };

    try {
      const firstFence = await app.inject({
        method: "POST",
        url: "/session/stream-session/quiesce",
        headers: auth,
        payload: {}
      });
      expect(firstFence.statusCode).toBe(200);

      const rejectedStart = await app.inject({
        method: "POST",
        url: "/session/start/stream",
        headers: auth,
        payload: {
          agent: "claude",
          name: "stream-session",
          directory: workspaceDir,
          task: "Do not cross the active fence.",
          contextFiles: []
        }
      });
      expect(rejectedStart.statusCode).toBe(200);
      expect(sseDataEvents(rejectedStart.body)).toContainEqual(
        expect.objectContaining({
          kind: "error",
          sessionName: "stream-session",
          code: "SESSION_QUIESCED",
          details: expect.objectContaining({
            quiescenceEpoch: 1,
            latestEpoch: 1
          })
        })
      );

      const authorizedStart = await app.inject({
        method: "POST",
        url: "/session/start/stream",
        headers: auth,
        payload: {
          agent: "claude",
          name: "stream-session",
          directory: workspaceDir,
          task: "Resume with the exact lifecycle epoch.",
          lifecycleEpoch: 1,
          contextFiles: []
        }
      });
      expect(authorizedStart.statusCode).toBe(200);
      expect(sseDataEvents(authorizedStart.body)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "result" }),
          expect.objectContaining({ kind: "done" })
        ])
      );

      const secondFence = await app.inject({
        method: "POST",
        url: "/session/stream-session/quiesce",
        headers: auth,
        payload: {}
      });
      expect(secondFence.statusCode).toBe(200);
      expect(JSON.parse(secondFence.body)).toMatchObject({
        details: { quiescenceEpoch: 2 }
      });

      const rejectedSend = await app.inject({
        method: "POST",
        url: "/session/stream-session/send/stream",
        headers: auth,
        payload: {
          message: "A stale epoch must not cross the new fence.",
          lifecycleEpoch: 1,
          contextFiles: []
        }
      });
      expect(rejectedSend.statusCode).toBe(200);
      expect(sseDataEvents(rejectedSend.body)).toContainEqual(
        expect.objectContaining({
          kind: "error",
          sessionName: "stream-session",
          code: "STALE_LIFECYCLE_EPOCH",
          details: expect.objectContaining({
            requestedEpoch: 1,
            latestEpoch: 2
          })
        })
      );

      const authorizedSend = await app.inject({
        method: "POST",
        url: "/session/stream-session/send/stream",
        headers: auth,
        payload: {
          message: "Resume through the current lifecycle.",
          lifecycleEpoch: 2,
          contextFiles: []
        }
      });
      expect(authorizedSend.statusCode).toBe(200);
      expect(sseDataEvents(authorizedSend.body)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "result" }),
          expect.objectContaining({ kind: "done" })
        ])
      );
    } finally {
      await app.close();
    }
  });
});
