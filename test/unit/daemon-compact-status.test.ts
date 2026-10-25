import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDaemonServer } from "../../src/daemon/server.js";
import {
  createTempDir,
  makeConfig,
  resolveFakeAcpxCommand,
  seedSession,
  seedTranscript,
  writeSeedState
} from "../helpers.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function loggingAcpx(workspace: string): Promise<{ command: string; log: string }> {
  const log = join(workspace, "acpx-calls.log");
  const command = join(workspace, "logging-acpx.sh");
  await writeFile(
    command,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(await resolveFakeAcpxCommand())} "$@"\n`,
    "utf8"
  );
  await chmod(command, 0o755);
  await writeFile(log, "", "utf8");
  return { command, log };
}

describe("compact status views", () => {
  it("serves view=summary without transcript, runtime probe or JSON duplication", async () => {
    const dataDir = await createTempDir("puppenclaw-summary-");
    const workspace = await createTempDir("puppenclaw-summary-ws-");
    const acpx = await loggingAcpx(workspace);
    await writeSeedState(dataDir, [
      seedSession("lab-big", workspace, {
        state: "waiting_input",
        pendingQuestion: "Which source?",
        transcript: seedTranscript(400, 5_000, "turn-1")
      })
    ]);
    const { app } = await createDaemonServer({ config: makeConfig({ acpxCommand: acpx.command }), dataDir, logger: quiet });
    try {
      const legacy = await app.inject({ method: "GET", url: "/session/lab-big" });
      expect(legacy.statusCode).toBe(200);
      const legacyBody = JSON.parse(legacy.body) as Record<string, unknown> & {
        details: { session: { transcript: unknown[] }; runtime: unknown };
      };
      expect(legacyBody.details.session.transcript).toHaveLength(400);
      expect(legacyBody.details.runtime).toBeDefined();
      expect(legacyBody).not.toHaveProperty("bootId");
      expect(await readFile(acpx.log, "utf8")).toMatch(/status --session lab-big/u);
      await writeFile(acpx.log, "", "utf8");

      const summary = await app.inject({ method: "GET", url: "/session/lab-big?view=summary" });
      expect(summary.statusCode).toBe(200);
      expect(Buffer.byteLength(summary.body)).toBeLessThan(4_096);
      expect(Buffer.byteLength(legacy.body)).toBeGreaterThan(2_000_000);
      const body = JSON.parse(summary.body) as {
        content: Array<{ text: string }>;
        details: Record<string, unknown> & { session: Record<string, unknown> };
        protocol: unknown;
        bootId: string;
        spoolId: string;
      };
      expect(body.content).toEqual([{ type: "text", text: "Status summary for lab-big" }]);
      expect(body.protocol).toEqual({ major: 2, minor: 0 });
      expect(body.bootId).toBe(summary.headers["x-puppenclaw-boot-id"]);
      expect(body.spoolId).toBe(summary.headers["x-puppenclaw-spool-id"]);
      expect(body.details.view).toBe("summary");
      expect(body.details).not.toHaveProperty("runtime");
      expect(body.details.turn).toMatchObject({ classification: "inactive" });
      expect(body.details.session).not.toHaveProperty("transcript");
      expect(body.details.session).toMatchObject({
        name: "lab-big",
        state: "waiting_input",
        pendingQuestion: "Which source?",
        transcriptSummary: {
          entries: 400,
          lastRole: "assistant",
          lastEntryAt: "2026-10-25T10:06:39.000Z",
          lastTurnId: "turn-1"
        }
      });
      // No `acpx status` process for the compact view.
      expect(await readFile(acpx.log, "utf8")).toBe("");
    } finally {
      await app.close();
    }
  });

  it("probes the runtime in the summary only for a session stored as active without an active turn", async () => {
    const dataDir = await createTempDir("puppenclaw-summary-stale-");
    const workspace = await createTempDir("puppenclaw-summary-stale-ws-");
    const acpx = await loggingAcpx(workspace);
    // A session record still "running" after a restart, with no live turn; its
    // transcript ended with the assistant's reply.
    await writeSeedState(dataDir, [
      seedSession("lab-stale", workspace, { state: "running", transcript: seedTranscript(4, 20, "turn-1") }),
      seedSession("lab-resting", workspace, { state: "idle", transcript: seedTranscript(4, 20, "turn-1") })
    ]);
    const { app } = await createDaemonServer({ config: makeConfig({ acpxCommand: acpx.command }), dataDir, logger: quiet });
    try {
      await writeFile(acpx.log, "", "utf8");
      const stale = JSON.parse((await app.inject({ method: "GET", url: "/session/lab-stale?view=summary" })).body) as {
        details: { session: Record<string, unknown>; runtime?: Record<string, unknown>; turn?: Record<string, unknown> };
      };
      expect(stale.details.session).toMatchObject({ state: "running", transcriptSummary: { lastRole: "assistant" } });
      expect(stale.details.session).not.toHaveProperty("transcript");
      expect(stale.details.turn).toMatchObject({ classification: "inactive" });
      // The same probe the full view runs, for this one session.
      expect(stale.details.runtime).toEqual(
        (JSON.parse((await app.inject({ method: "GET", url: "/session/lab-stale" })).body) as { details: { runtime: unknown } })
          .details.runtime
      );
      expect(await readFile(acpx.log, "utf8")).toMatch(/status --session lab-stale/u);

      await writeFile(acpx.log, "", "utf8");
      const resting = JSON.parse((await app.inject({ method: "GET", url: "/session/lab-resting?view=summary" })).body) as {
        details: Record<string, unknown>;
      };
      expect(resting.details).not.toHaveProperty("runtime");
      expect(await readFile(acpx.log, "utf8")).toBe("");
    } finally {
      await app.close();
    }
  });

  it("limits the transcript to its newest entries in either view and counts all of them", async () => {
    const dataDir = await createTempDir("puppenclaw-transcript-limit-");
    const workspace = await createTempDir("puppenclaw-transcript-limit-ws-");
    await writeSeedState(dataDir, [seedSession("lab-limit", workspace, { transcript: seedTranscript(30, 20) })]);
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      dataDir,
      logger: quiet
    });
    try {
      const full = JSON.parse(
        (await app.inject({ method: "GET", url: "/session/lab-limit?transcriptLimit=3" })).body
      ) as { content: Array<{ text: string }>; details: { session: { transcript: Array<{ text: string }>; transcriptSummary: { entries: number } }; runtime: unknown }; bootId: string };
      expect(full.details.runtime).toBeDefined();
      expect(full.details.session.transcript.map((entry) => entry.text.split(":")[0])).toEqual(["27", "28", "29"]);
      expect(full.details.session.transcriptSummary.entries).toBe(30);
      expect(full.bootId).toBeDefined();
      expect(full.content[0]?.text.startsWith("Status for lab-limit")).toBe(true);
      expect(full.content[0]?.text).not.toContain("0:xxxx");

      const summary = JSON.parse(
        (await app.inject({ method: "GET", url: "/session/lab-limit?view=summary&transcriptLimit=2" })).body
      ) as { details: { session: { transcript: Array<{ text: string }> } } };
      expect(summary.details.session.transcript.map((entry) => entry.text.split(":")[0])).toEqual(["28", "29"]);

      const none = JSON.parse(
        (await app.inject({ method: "GET", url: "/session/lab-limit?transcriptLimit=0" })).body
      ) as { details: { session: { transcript: unknown[] } } };
      expect(none.details.session.transcript).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("lists every session compactly with /sessions?view=summary", async () => {
    const dataDir = await createTempDir("puppenclaw-sessions-summary-");
    const workspace = await createTempDir("puppenclaw-sessions-summary-ws-");
    await writeSeedState(
      dataDir,
      Array.from({ length: 200 }, (_, index) =>
        seedSession(`lab-${index}`, workspace, { transcript: seedTranscript(50, 1_000) })
      )
    );
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      dataDir,
      logger: quiet
    });
    try {
      const response = await app.inject({ method: "GET", url: "/sessions?view=summary" });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        details: { view: string; sessions: Array<Record<string, unknown>> };
      };
      expect(body.details.view).toBe("summary");
      expect(body.details.sessions).toHaveLength(200);
      expect(body.details.sessions[0]).not.toHaveProperty("transcript");
      expect(body.details.sessions[0]).toMatchObject({ transcriptSummary: { entries: 50 }, turn: { classification: "inactive" } });
      expect(Buffer.byteLength(response.body)).toBeLessThan(300_000);
    } finally {
      await app.close();
    }
  });

  it("serves /output in the summary view without the session transcript or JSON duplication", async () => {
    const dataDir = await createTempDir("puppenclaw-output-summary-");
    const workspace = await createTempDir("puppenclaw-output-summary-ws-");
    await writeSeedState(dataDir, [
      seedSession("lab-out", workspace, { transcript: seedTranscript(400, 5_000, "turn-1") })
    ]);
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      dataDir,
      logger: quiet
    });
    type OutputBody = {
      content: Array<{ type: string; text: string }>;
      details: Record<string, unknown> & {
        session: Record<string, unknown> & { transcript?: Array<{ text: string }> };
        output: { text: string; source: string; turnId: string | null };
      };
      bootId?: string;
    };
    try {
      const legacy = await app.inject({ method: "GET", url: "/session/lab-out/output" });
      expect(legacy.statusCode).toBe(200);
      const legacyBody = JSON.parse(legacy.body) as OutputBody;
      expect(legacyBody.details.session.transcript).toHaveLength(400);
      expect(legacyBody).not.toHaveProperty("bootId");
      expect(Buffer.byteLength(legacy.body)).toBeGreaterThan(2_000_000);

      const summary = await app.inject({
        method: "GET",
        url: "/session/lab-out/output?view=summary&transcriptLimit=1"
      });
      expect(summary.statusCode).toBe(200);
      expect(Buffer.byteLength(summary.body)).toBeLessThan(16_384);
      const body = JSON.parse(summary.body) as OutputBody;
      expect(body.content).toEqual([{ type: "text", text: "Output for lab-out" }]);
      expect(body.bootId).toBe(summary.headers["x-puppenclaw-boot-id"]);
      expect(body.details.view).toBe("summary");
      expect(body.details.output).toEqual(legacyBody.details.output);
      expect(body.details.output).toMatchObject({ source: "transcript", turnId: "turn-1" });
      expect(body.details.session.transcript?.map((entry) => entry.text.split(":")[0])).toEqual(["399"]);
      expect(body.details.session).toMatchObject({
        name: "lab-out",
        transcriptSummary: { entries: 400, lastRole: "assistant", lastTurnId: "turn-1" }
      });

      const bare = JSON.parse(
        (await app.inject({ method: "GET", url: "/session/lab-out/output?view=summary" })).body
      ) as OutputBody;
      expect(bare.details.session).not.toHaveProperty("transcript");

      const limited = JSON.parse(
        (await app.inject({ method: "GET", url: "/session/lab-out/output?transcriptLimit=2" })).body
      ) as OutputBody;
      expect(limited.details.session.transcript?.map((entry) => entry.text.split(":")[0])).toEqual(["398", "399"]);
      expect(limited.details.output).toEqual(legacyBody.details.output);

      const refused = await app.inject({ method: "GET", url: "/session/lab-out/output?view=compact" });
      expect(refused.statusCode).toBe(400);
      expect(JSON.parse(refused.body)).toMatchObject({ code: "INVALID_PARAMS" });
    } finally {
      await app.close();
    }
  });

  it("reports quiesced sessions, rejects bad view parameters and keeps NO_SESSION", async () => {
    const dataDir = await createTempDir("puppenclaw-summary-edges-");
    const workspace = await createTempDir("puppenclaw-summary-edges-ws-");
    await writeSeedState(dataDir, [seedSession("lab-quiet", workspace)]);
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      dataDir,
      logger: quiet
    });
    try {
      expect((await app.inject({ method: "POST", url: "/session/lab-quiet/quiesce" })).statusCode).toBe(200);
      const quiesced = JSON.parse(
        (await app.inject({ method: "GET", url: "/session/lab-quiet?view=summary" })).body
      ) as { details: Record<string, unknown> & { session: { state: string } } };
      expect(quiesced.details.lifecycle).toEqual({ quiesced: true, epoch: 1 });
      expect(quiesced.details.session.state).toBe("stopped");
      expect(quiesced.details).not.toHaveProperty("turn");

      for (const query of ["view=compact", "transcriptLimit=-1", "transcriptLimit=5000", "transcriptLimit=abc"]) {
        const response = await app.inject({ method: "GET", url: `/session/lab-quiet?${query}` });
        expect(response.statusCode, query).toBe(400);
        expect(JSON.parse(response.body)).toMatchObject({ code: "INVALID_PARAMS" });
      }
      const missing = await app.inject({ method: "GET", url: "/session/nope?view=summary" });
      expect(missing.statusCode).toBe(404);
      expect(JSON.parse(missing.body)).toMatchObject({ code: "NO_SESSION" });
      // Unknown query keys stay ignored, as before.
      expect((await app.inject({ method: "GET", url: "/session/lab-quiet?format=json" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
