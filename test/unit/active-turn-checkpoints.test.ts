import { afterEach, describe, expect, it, vi } from "vitest";

import { AcpxSessionManager } from "../../src/manager/acpx.js";
import {
  createStoreAndRouter,
  createTempDir,
  makeConfig,
  resolveFakeAcpxStreamCommand
} from "../helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("condition not reached");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("live-turn checkpoints", () => {
  it("checkpoints all live turns on one shared tick, one group-committed write per tick", async () => {
    vi.stubEnv("PUPPENCLAW_ACTIVE_TURN_CHECKPOINT_MS", "400");
    const root = await createTempDir("puppenclaw-checkpoints-");
    const workspace = await createTempDir("puppenclaw-checkpoints-ws-");
    const { store, outputRouter } = await createStoreAndRouter(root);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand: resolveFakeAcpxStreamCommand() }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store,
      outputRouter
    });
    const names = ["checkpoint-a", "checkpoint-b", "checkpoint-c"];
    try {
      const turns = names.map((name) =>
        manager.start({
          agent: "claude",
          name,
          directory: workspace,
          task: "STREAM_CHUNKS=50 STREAM_INTERVAL_MS=40 STREAM_CHUNK_CHARS=20",
          contextFiles: [],
          skills: []
        })
      );
      const liveChars = async (name: string): Promise<number> => {
        const status = await manager.status({ name });
        return (status.details as { turn: { outputChars: number } }).turn.outputChars;
      };
      // Every turn is streaming before the measured window starts.
      await until(() => names.every((name) => store.getSession(name)?.activeTurn?.pid != null));
      for (const name of names) {
        await vi.waitFor(async () => expect(await liveChars(name)).toBeGreaterThan(0), { timeout: 5_000 });
      }
      const windowStart = store.persistenceStats().writes;
      const startedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 1_250));
      const elapsed = Date.now() - startedAt;
      const windowWrites = store.persistenceStats().writes - windowStart;
      // Persisted progress moved mid-turn, and status reads see the live values.
      for (const name of names) {
        const persistedChars = store.getSession(name)?.activeTurn?.outputChars ?? 0;
        expect(persistedChars).toBeGreaterThan(0);
        expect(await liveChars(name)).toBeGreaterThanOrEqual(persistedChars);
      }
      await Promise.all(turns);
      // One write per tick for all three turns, not one per turn per tick.
      expect(windowWrites).toBeLessThanOrEqual(Math.ceil(elapsed / 400) + 1);
      expect(store.persistenceStats().largestBatch).toBeGreaterThanOrEqual(names.length);
      for (const name of names) {
        expect(store.getSession(name)?.activeTurn).toMatchObject({ state: "completed", outputChars: 1_000 });
      }
    } finally {
      await store.close();
    }
  }, 30_000);
});
