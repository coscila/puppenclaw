import { afterEach, describe, expect, it, vi } from "vitest";

import { EventLoopMonitor } from "../../src/daemon/event-loop.js";
import { AcpxSessionManager } from "../../src/manager/acpx.js";
import {
  createStoreAndRouter,
  createTempDir,
  makeConfig,
  resolveFakeAcpxStreamCommand,
  seedSession,
  seedTranscript,
  writeSeedState
} from "../helpers.js";

/**
 * Plan H4 acceptance, scaled: with 5 active turns on a production-sized store
 * (about 9 MB of transcripts), state.json is written once per checkpoint tick,
 * not once per turn per tick, and the event loop stays responsive. At the 30 s
 * default tick that is 2 checkpoint writes per minute (target: at most 12).
 * scripts/measure-h4.mts runs the same measurement unscaled.
 */

const TICK_MS = Number(process.env.PUPPENCLAW_LOAD_TEST_TICK_MS ?? 2_000);
const WINDOW_MS = Number(process.env.PUPPENCLAW_LOAD_TEST_WINDOW_MS ?? 10_000);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("five active turns", () => {
  it(
    "write state.json once per checkpoint tick and keep event-loop p99 under 50 ms",
    async () => {
      vi.stubEnv("PUPPENCLAW_ACTIVE_TURN_CHECKPOINT_MS", String(TICK_MS));
      const root = await createTempDir("puppenclaw-load-");
      const workspace = await createTempDir("puppenclaw-load-ws-");
      await writeSeedState(
        root,
        Array.from({ length: 165 }, (_, index) =>
          seedSession(`lab-history-${index}`, workspace, { transcript: seedTranscript(28, 2_000) })
        )
      );
      const { store, outputRouter } = await createStoreAndRouter(root);
      const manager = new AcpxSessionManager({
        config: makeConfig({ acpxCommand: resolveFakeAcpxStreamCommand(), maxSessions: 10 }),
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        store,
        outputRouter
      });
      const names = Array.from({ length: 5 }, (_, index) => `lab-live-${index}`);
      const chunks = Math.ceil((WINDOW_MS + 8_000) / 50);
      const monitor = new EventLoopMonitor({ resolutionMs: 10, windowMs: 3_600_000 });
      try {
        const turns = names.map((name) =>
          manager.start({
            agent: "claude",
            name,
            directory: workspace,
            task: `STREAM_CHUNKS=${chunks} STREAM_INTERVAL_MS=50 STREAM_CHUNK_CHARS=200 STREAM_ACTIVITY_EVERY=10`,
            contextFiles: [],
            skills: []
          })
        );
        // Steady state: every turn is streaming.
        await vi.waitFor(
          () => {
            for (const name of names) {
              expect(store.getSession(name)?.activeTurn?.pid).toBeDefined();
            }
          },
          { timeout: 15_000, interval: 50 }
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        const before = store.persistenceStats();
        monitor.start();
        const startedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, WINDOW_MS));
        const elapsed = Date.now() - startedAt;
        const lag = monitor.snapshot();
        monitor.stop();
        const after = store.persistenceStats();
        const writes = after.writes - before.writes;
        const ticks = Math.ceil(elapsed / TICK_MS);
        console.info(
          `5 live turns, ${TICK_MS} ms tick, ${elapsed} ms window: ${writes} state.json writes ` +
            `(${after.mutations - before.mutations} mutations, largest batch ${after.largestBatch}), ` +
            `event-loop p99 ${lag.p99Ms} ms, max ${lag.maxMs} ms`
        );
        // One group-committed write per tick for all five turns (plus at most one stray).
        expect(writes).toBeLessThanOrEqual(ticks + 1);
        expect(after.mutations - before.mutations).toBeGreaterThanOrEqual(writes);
        expect(lag.p99Ms).toBeLessThan(50);
        for (const name of names) {
          await manager.stop({ name });
        }
        await Promise.allSettled(turns);
      } finally {
        monitor.stop();
        await store.close();
      }
    },
    WINDOW_MS + 60_000
  );
});
