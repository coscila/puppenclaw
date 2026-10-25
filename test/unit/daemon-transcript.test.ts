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

type Page = {
  details: {
    name: string;
    total: number;
    generation: number;
    after: number;
    next: number;
    hasMore: boolean;
    entries: Array<{ seq: number; role: string; text: string; createdAt: string }>;
  };
  bootId: string;
};

describe("GET /session/:name/transcript", () => {
  it("pages through the transcript with seq cursors and a size budget", async () => {
    const dataDir = await createTempDir("puppenclaw-transcript-pages-");
    const workspace = await createTempDir("puppenclaw-transcript-pages-ws-");
    await writeSeedState(dataDir, [
      seedSession("lab-pages", workspace, { transcript: seedTranscript(250, 30) }),
      seedSession("lab-huge", workspace, {
        transcript: [
          { role: "assistant", text: "a".repeat(1_500_000), createdAt: "2026-10-25T10:00:00.000Z" },
          { role: "user", text: "b".repeat(400_000), createdAt: "2026-10-25T10:00:01.000Z" },
          { role: "assistant", text: "c".repeat(400_000), createdAt: "2026-10-25T10:00:02.000Z" },
          { role: "user", text: "d".repeat(400_000), createdAt: "2026-10-25T10:00:03.000Z" }
        ]
      })
    ]);
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      dataDir,
      logger: quiet
    });
    const page = async (url: string): Promise<Page> => {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      return JSON.parse(response.body) as Page;
    };
    try {
      const seen: number[] = [];
      let after = 0;
      for (let round = 0; round < 5; round += 1) {
        const current = await page(`/session/lab-pages/transcript?after=${after}&limit=100`);
        expect(current.details).toMatchObject({ name: "lab-pages", total: 250, generation: 0, after });
        seen.push(...current.details.entries.map((entry) => entry.seq));
        after = current.details.next;
        if (!current.details.hasMore) {
          break;
        }
      }
      expect(seen).toEqual(Array.from({ length: 250 }, (_, index) => index + 1));
      const first = await page("/session/lab-pages/transcript");
      expect(first.details.entries).toHaveLength(100);
      expect(first.details.entries[0]).toMatchObject({ seq: 1, role: "user", text: expect.stringMatching(/^0:x+$/u) });
      expect(first.bootId).toBeDefined();

      const end = await page("/session/lab-pages/transcript?after=250");
      expect(end.details).toMatchObject({ entries: [], next: 250, hasMore: false });
      const beyond = await page("/session/lab-pages/transcript?after=900");
      expect(beyond.details).toMatchObject({ entries: [], total: 250, hasMore: false });

      // The first entry is always returned; later ones stop at about 1 MB per page.
      const big = await page("/session/lab-huge/transcript?limit=10");
      expect(big.details.entries.map((entry) => entry.seq)).toEqual([1]);
      const rest = await page(`/session/lab-huge/transcript?after=${big.details.next}&limit=10`);
      expect(rest.details.entries.map((entry) => entry.seq)).toEqual([2, 3]);
      expect(rest.details.hasMore).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("validates the cursor and keeps NO_SESSION", async () => {
    const dataDir = await createTempDir("puppenclaw-transcript-errors-");
    const workspace = await createTempDir("puppenclaw-transcript-errors-ws-");
    await writeSeedState(dataDir, [seedSession("lab-errors", workspace)]);
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand(), daemonAuthToken: "transcript-token" }),
      dataDir,
      logger: quiet
    });
    const headers = { authorization: "Bearer transcript-token" };
    try {
      expect((await app.inject({ method: "GET", url: "/session/lab-errors/transcript" })).statusCode).toBe(401);
      for (const query of ["limit=0", "limit=501", "after=-1", "after=x"]) {
        const response = await app.inject({ method: "GET", url: `/session/lab-errors/transcript?${query}`, headers });
        expect(response.statusCode, query).toBe(400);
      }
      const missing = await app.inject({ method: "GET", url: "/session/missing/transcript", headers });
      expect(missing.statusCode).toBe(404);
      expect(JSON.parse(missing.body)).toMatchObject({ code: "NO_SESSION" });
    } finally {
      await app.close();
    }
  });
});
