import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDaemonServer } from "../../src/daemon/server.js";
import { UsageLedgerStore } from "../../src/shared/usage-ledger.js";
import type { UsageLedgerEntry } from "../../src/shared/types.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

const TOKEN = "ledger-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function entry(index: number): UsageLedgerEntry {
  return {
    id: `usage-${index}`,
    sessionName: `lab-${index % 7}`,
    agent: "claude",
    provider: "anthropic",
    model: "claude-test",
    usage: { input: index, output: 1, cacheRead: 0, cacheWrite: 0, total: index + 1 },
    durationMs: 10,
    // Timestamps deliberately out of order: the cursor follows insertion, not time.
    timestamp: new Date(Date.parse("2026-10-25T10:00:00.000Z") - index * 1_000).toISOString(),
    ...(index % 2 === 0 ? { turnId: `turn-${index}`, role: "main" as const } : {})
  };
}

type Page = {
  ok: boolean;
  ledgerId: string;
  rows: Array<UsageLedgerEntry & { seq: number }>;
  next: number;
  hasMore: boolean;
  head: number;
  bootId: string;
};

async function seedLedger(dataDir: string, count: number): Promise<void> {
  const ledger = await UsageLedgerStore.open(join(dataDir, "usage"));
  ledger.appendMany(Array.from({ length: count }, (_, index) => entry(index)));
  ledger.append(entry(3));
  ledger.close();
}

describe("GET /usage/ledger", () => {
  it("pages every ledger row once, in insertion order, with a stable ledger id", async () => {
    const dataDir = await createTempDir("puppenclaw-ledger-pages-");
    await seedLedger(dataDir, 1_200);
    let ledgerId = "";
    {
      const { app } = await createDaemonServer({
        config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand(), daemonAuthToken: TOKEN }),
        dataDir,
        logger: quiet
      });
      try {
        expect((await app.inject({ method: "GET", url: "/usage/ledger" })).statusCode).toBe(401);
        const ids: string[] = [];
        const seqs: number[] = [];
        let after = 0;
        let pages = 0;
        while (true) {
          const response = await app.inject({ method: "GET", url: `/usage/ledger?afterId=${after}`, headers: auth });
          expect(response.statusCode).toBe(200);
          const page = JSON.parse(response.body) as Page;
          pages += 1;
          ledgerId = page.ledgerId;
          expect(page.head).toBe(1_200);
          expect(page.bootId).toBe(response.headers["x-puppenclaw-boot-id"]);
          ids.push(...page.rows.map((row) => row.id));
          seqs.push(...page.rows.map((row) => row.seq));
          after = page.next;
          if (!page.hasMore) {
            break;
          }
        }
        expect(pages).toBe(3);
        expect(ids).toEqual(Array.from({ length: 1_200 }, (_, index) => `usage-${index}`));
        expect(seqs).toEqual(Array.from({ length: 1_200 }, (_, index) => index + 1));

        const small = JSON.parse(
          (await app.inject({ method: "GET", url: "/usage/ledger?limit=2", headers: auth })).body
        ) as Page;
        expect(small.rows).toEqual([
          { ...entry(0), seq: 1 },
          { ...entry(1), seq: 2 }
        ]);
        const resumed = JSON.parse(
          (await app.inject({ method: "GET", url: "/usage/ledger?afterId=usage-9&limit=1", headers: auth })).body
        ) as Page;
        expect(resumed.rows.map((row) => row.id)).toEqual(["usage-10"]);
        const tail = JSON.parse(
          (await app.inject({ method: "GET", url: "/usage/ledger?afterId=1200", headers: auth })).body
        ) as Page;
        expect(tail).toMatchObject({ rows: [], next: 1_200, hasMore: false });
      } finally {
        await app.close();
      }
    }
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand(), daemonAuthToken: TOKEN }),
      dataDir,
      logger: quiet
    });
    try {
      const page = JSON.parse((await app.inject({ method: "GET", url: "/usage/ledger?limit=1", headers: auth })).body) as Page;
      expect(page.ledgerId).toBe(ledgerId);
    } finally {
      await app.close();
    }
    const fresh = await UsageLedgerStore.open(join(await createTempDir("puppenclaw-ledger-fresh-"), "usage"));
    expect(fresh.ledgerId).not.toBe(ledgerId);
    expect(fresh.page(0, 10)).toMatchObject({ rows: [], next: 0, hasMore: false, head: 0 });
    fresh.close();
  });

  it("rejects unknown cursors and out-of-range limits, and records new turns", async () => {
    const dataDir = await createTempDir("puppenclaw-ledger-errors-");
    const workspace = await createTempDir("puppenclaw-ledger-errors-ws-");
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand(), daemonAuthToken: TOKEN }),
      dataDir,
      logger: quiet
    });
    try {
      const unknown = await app.inject({ method: "GET", url: "/usage/ledger?afterId=usage-missing", headers: auth });
      expect(unknown.statusCode).toBe(400);
      expect(JSON.parse(unknown.body)).toMatchObject({ code: "INVALID_LEDGER_CURSOR" });
      for (const query of ["limit=0", "limit=1001", "limit=x"]) {
        expect((await app.inject({ method: "GET", url: `/usage/ledger?${query}`, headers: auth })).statusCode, query).toBe(400);
      }
      const started = await app.inject({
        method: "POST",
        url: "/session/start",
        headers: auth,
        payload: { agent: "claude", name: "lab-ledger", directory: workspace, task: "count my tokens" }
      });
      expect(started.statusCode).toBe(200);
      const page = JSON.parse((await app.inject({ method: "GET", url: "/usage/ledger", headers: auth })).body) as Page;
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).toMatchObject({ seq: 1, sessionName: "lab-ledger", agent: "claude", usage: { output: 12 } });
    } finally {
      await app.close();
    }
  });
});
