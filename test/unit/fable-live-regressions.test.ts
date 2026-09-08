import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { createStoreAndRouter, createTempDir, makeConfig } from "../helpers.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };
async function fixture() {
  const workspace = await createTempDir("puppenclaw-fable-live-");
  const { store, outputRouter } = await createStoreAndRouter(workspace);
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL("../fixtures/fake-fable-reconnect.mjs", import.meta.url)))}`;
  const manager = new AcpxSessionManager({ config: makeConfig({ acpxCommand: command }), store, outputRouter, logger });
  return { manager, store, workspace };
}

describe("native Fable rollout regressions", () => {
  it("does not promote a recovered native OAuth diagnostic into successful assistant output", async () => {
    const { manager, store, workspace } = await fixture();
    try {
      const result = await manager.start({ agent: "claude", name: "auth-reconnect", directory: workspace, task: "simulate-reconnect-auth", contextFiles: [] });
      expect(result.details).toMatchObject({ failureCode: "PROVIDER_AUTHENTICATION_REQUIRED", session: { state: "failed", failureCode: "PROVIDER_AUTHENTICATION_REQUIRED", retryable: false } });
      const session = store.getSession("auth-reconnect");
      expect(session?.activeTurn?.state).toBe("failed");
      expect(session?.transcript.some((entry) => entry.role === "assistant")).toBe(false);
      expect(session?.transcript.at(-1)).toMatchObject({ role: "status" });
    } finally { await store.close(); }
  });

  it("still recovers ordinary assistant prose mentioning expired credentials", async () => {
    const { manager, store, workspace } = await fixture();
    try {
      const result = await manager.start({ agent: "claude", name: "answer-reconnect", directory: workspace, task: "simulate-reconnect-answer", contextFiles: [] });
      expect(result.details).toMatchObject({ session: { state: "idle" } });
      expect(store.getSession("answer-reconnect")?.transcript.at(-1)).toMatchObject({ role: "assistant", text: "I documented why OAuth credentials expire; the synthetic task is complete." });
    } finally { await store.close(); }
  });

  it("proves first-attempt closure when sandbox control startup exceeds one second", async () => {
    const { manager, store, workspace } = await fixture();
    try {
      await manager.start({ agent: "claude", name: "slow-close", directory: workspace, task: "Prime the synthetic session.", contextFiles: [] });
      await writeFile(join(workspace, ".slow-runtime-controls"), "synthetic\n");
      const started = Date.now();
      expect((await manager.quiesce({ name: "slow-close" })).details).toMatchObject({ runtimeClosed: true });
      expect(Date.now() - started).toBeLessThan(15000);
      expect((await manager.output({ name: "slow-close" })).details).toMatchObject({ turn: { lockHeld: false, trackedChild: false, processAlive: false } });
    } finally { await store.close(); }
  }, 20000);
});
