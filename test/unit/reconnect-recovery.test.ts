import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { createStoreAndRouter, createTempDir, makeConfig } from "../helpers.js";

const oldAnswer = "OLD ASSISTANT OUTPUT";
const oldRecord = {
  acpxRecordId: "reconnect-fixture",
  updated_at: "2020-01-01T00:00:00Z",
  messages: [
    { User: { id: "previous-user", content: [{ Text: "Previous request" }] } },
    { Agent: { content: [{ Text: oldAnswer }] } }
  ]
};

async function fixture(options: Record<string, unknown>, baseline = oldRecord) {
  const workspace = await createTempDir("puppenclaw-reconnect-recovery-");
  await writeFile(join(workspace, ".fake-reconnect-options.json"), JSON.stringify(options));
  await writeFile(join(workspace, ".fake-reconnect-output"), JSON.stringify(baseline));
  const { store, outputRouter } = await createStoreAndRouter(workspace);
  const completed = vi.spyOn(outputRouter, "onComplete");
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL("../fixtures/fake-fable-reconnect.mjs", import.meta.url)))}`;
  const manager = new AcpxSessionManager({
    config: makeConfig({ acpxCommand: command }), store, outputRouter,
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  });
  return {
    manager, store, workspace, completed,
    run: () => manager.start({ agent: "claude", name: "reconnect-test", directory: workspace,
      task: "Current request", contextFiles: [] }),
    attempts: async () => Number(await readFile(join(workspace, ".fake-reconnect-attempts"), "utf8"))
  };
}

describe("turn-specific ACPX reconnect handling", () => {
  it.each([false, true])("never promotes timestamp-refreshed old history (missing baseline: %s)", async (missingBaseline) => {
    const env = await fixture({ kind: "stale", missingBaseline });
    try {
      expect((await env.run()).details).toMatchObject({ failureCode: "PROVIDER_CONNECTION_FAILED", session: { state: "failed" } });
      const session = env.store.getSession("reconnect-test");
      expect(session?.activeTurn?.state).toBe("failed");
      expect(session?.transcript.some((entry) => entry.role === "assistant")).toBe(false);
      expect(env.completed).not.toHaveBeenCalled();
      expect(await env.attempts()).toBe(1);
    } finally { await env.store.close(); }
  });

  it("ignores reconnect banners on stdout and stderr when a fresh answer completes", async () => {
    const env = await fixture({ kind: "banner-success" });
    try {
      await env.run();
      expect(env.store.getSession("reconnect-test")?.transcript.at(-1)).toMatchObject({ role: "assistant", text: "Fresh answer." });
      expect(env.completed).toHaveBeenCalledTimes(1);
      expect(await env.attempts()).toBe(1);
    } finally { await env.store.close(); }
  });

  it.each([false, true])("recovers a fresh persisted answer only after terminal completion (trimmed history: %s)", async (dropOldMessages) => {
    // Identical answer text across two turns is legitimate: identity, not text
    // deduplication, determines whether this is the current answer.
    const env = await fixture({ kind: "persisted", text: oldAnswer, dropOldMessages });
    try {
      await env.run();
      expect(env.store.getSession("reconnect-test")?.transcript.at(-1)).toMatchObject({ role: "assistant", text: oldAnswer });
      expect(env.completed).toHaveBeenCalledTimes(1);
      expect(await env.attempts()).toBe(1);
    } finally { await env.store.close(); }
  });

  it.each([
    { replaceRecord: true }, { missingBaseline: true }, { noFreshUser: true },
    { wrongPrompt: true }, { appendOtherUser: true }
  ])("rejects unprovable persisted output: %j", async (options) => {
    const env = await fixture({ kind: "persisted", ...options });
    try {
      expect((await env.run()).details).toMatchObject({ session: { state: "failed" } });
      expect(env.store.getSession("reconnect-test")?.transcript.some((entry) => entry.role === "assistant")).toBe(false);
      expect(env.completed).not.toHaveBeenCalled();
      expect(await env.attempts()).toBe(1);
    } finally { await env.store.close(); }
  }, 15_000);

  it.each(["missing-terminal", "partial-disconnect"])("does not report partial work as successful or resend it: %s", async (kind) => {
    const env = await fixture({ kind });
    try {
      expect((await env.run()).details).toMatchObject({ session: { state: "failed" } });
      expect(env.store.getSession("reconnect-test")?.activeTurn?.state).toBe("failed");
      expect(env.store.getSession("reconnect-test")?.transcript.at(-1)?.role).toBe("status");
      expect(env.completed).not.toHaveBeenCalled();
      expect(await env.attempts()).toBe(1);
    } finally { await env.store.close(); }
  });

  it.each([{ errorAfterDone: true }, { exitCode: 2 }, { signal: "SIGTERM" }])("does not let terminal text override a real failure: %j", async (options) => {
    const env = await fixture({ kind: "persisted", ...options });
    try {
      expect((await env.run()).details).toMatchObject({ session: { state: "failed" } });
      expect(env.store.getSession("reconnect-test")?.transcript.some((entry) => entry.role === "assistant")).toBe(false);
      expect(env.completed).not.toHaveBeenCalled();
      expect(await env.attempts()).toBe(1);
    } finally { await env.store.close(); }
  });

  it.each(["QUEUE_OWNER_CLOSED", "QUEUE_OWNER_SHUTTING_DOWN", "QUEUE_OWNER_OVERLOADED", "QUEUE_OWNER_GENERATION_MISMATCH"])("retries one explicitly rejected pre-dispatch request: %s", async (detailCode) => {
    const env = await fixture({ kind: "queue", detailCode });
    try {
      await env.run();
      expect(env.store.getSession("reconnect-test")?.transcript.at(-1)).toMatchObject({ role: "assistant", text: "Retried once." });
      expect(env.completed).toHaveBeenCalledTimes(1);
      expect(await env.attempts()).toBe(2);
    } finally { await env.store.close(); }
  });

  it("does not retry a second rejection", async () => {
    const env = await fixture({ kind: "queue", alwaysReject: true });
    try {
      expect((await env.run()).details).toMatchObject({ session: { state: "failed" } });
      expect(env.completed).not.toHaveBeenCalled();
      expect(await env.attempts()).toBe(2);
    } finally { await env.store.close(); }
  });

  it.each([
    { detailCode: "QUEUE_ACK_MISSING" }, { detailCode: "QUEUE_DISCONNECTED_BEFORE_ACK" },
    { detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION" }, { origin: "runtime" },
    { activity: "tool" }, { activity: "text" }, { activity: "raw" }, { activity: "usage" }, { appendUser: true },
    { missingBaseline: true }, { retryable: false }
  ])("never resubmits when dispatch is uncertain or forbidden: %j", async (options) => {
    const env = await fixture({ kind: "queue", ...options });
    try {
      expect((await env.run()).details).toMatchObject({ session: { state: "failed" } });
      expect(env.completed).not.toHaveBeenCalled();
      expect(await env.attempts()).toBe(1);
    } finally { await env.store.close(); }
  });

  it("cancellation during completed-turn output recovery cannot publish or resubmit", async () => {
    const env = await fixture({ kind: "persisted", noFreshUser: true });
    try {
      const pending = env.run();
      // Wait for actual provider dispatch, then let recovery begin.
      await vi.waitFor(async () => expect(await env.attempts()).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await env.manager.stop({ name: "reconnect-test" });
      await pending;
      expect(env.store.getSession("reconnect-test")?.state).toBe("stopped");
      expect(env.store.getSession("reconnect-test")?.transcript.some((entry) => entry.role === "assistant")).toBe(false);
      expect(env.completed).not.toHaveBeenCalled();
      expect(await env.attempts()).toBe(1);
    } finally { await env.store.close(); }
  });
});
