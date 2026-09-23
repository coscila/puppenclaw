import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDaemonServer } from "../../src/daemon/server.js";
import { UsageLedgerStore } from "../../src/shared/usage-ledger.js";
import type { NormalizedUsage, UsageLedgerEntry } from "../../src/shared/types.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0): NormalizedUsage {
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function entry(overrides: Partial<UsageLedgerEntry> & Pick<UsageLedgerEntry, "id">): UsageLedgerEntry {
  return {
    sessionName: "lab-chat",
    agent: "codex",
    provider: "remote_langdock_gpt6_luna_xhigh",
    model: "gpt-6-luna",
    usage: usage(10, 1),
    durationMs: 100,
    timestamp: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

describe("usage ledger per-model turn rows", () => {
  const stores: UsageLedgerStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  it("counts distinct turns across per-model rows and keeps legacy rows as one turn each", async () => {
    const ledger = await UsageLedgerStore.open(await createTempDir("ledger-turns-"));
    stores.push(ledger);
    ledger.append(entry({ id: "usage-legacy-1", usage: usage(5, 5) }));
    const turn = [
      entry({ id: "usage-t1-main", turnId: "t1", role: "main", threads: 1, usage: usage(100, 10, 50) }),
      entry({ id: "usage-t1-sub", turnId: "t1", role: "subagent", threads: 4, model: "chat", usage: usage(1000, 100, 500) })
    ];
    ledger.appendMany(turn);
    ledger.appendMany([
      entry({ id: "usage-t2-main", turnId: "t2", role: "main", threads: 1, usage: usage(1, 1),
        timestamp: "2026-09-02T00:00:00.000Z" })
    ]);

    expect(ledger.perSessionTotals("lab-chat")).toEqual({
      turns: 3,
      usage: usage(1106, 116, 550)
    });
    expect(ledger.grandTotals()).toEqual({ turns: 3, usage: usage(1106, 116, 550) });
    expect(ledger.grandTotals("2026-09-02T00:00:00.000Z")).toEqual({ turns: 1, usage: usage(1, 1) });
    expect(ledger.perModelRollup()).toEqual([
      { provider: "remote_langdock_gpt6_luna_xhigh", model: "chat", turns: 1, usage: usage(1000, 100, 500) },
      { provider: "remote_langdock_gpt6_luna_xhigh", model: "gpt-6-luna", turns: 3, usage: usage(106, 16, 50) }
    ]);
    // History stays row-level and carries the per-model attribution fields.
    const history = ledger.perSessionHistory("lab-chat", 10);
    expect(history).toHaveLength(4);
    expect(history.find((row) => row.id === "usage-t1-sub")).toEqual(turn[1]);
  });

  it("counts a turn once when its main and subagent rows share a provider and model", async () => {
    const ledger = await UsageLedgerStore.open(await createTempDir("ledger-same-model-"));
    stores.push(ledger);
    ledger.appendMany([
      entry({ id: "usage-t-main", turnId: "t", role: "main", threads: 1, model: "chat" }),
      entry({ id: "usage-t-sub", turnId: "t", role: "subagent", threads: 2, model: "chat" })
    ]);
    expect(ledger.perModelRollup()).toEqual([
      { provider: "remote_langdock_gpt6_luna_xhigh", model: "chat", turns: 1, usage: usage(20, 2) }
    ]);
  });

  it("is idempotent for repeated per-model rows of the same turn", async () => {
    const ledger = await UsageLedgerStore.open(await createTempDir("ledger-idempotent-"));
    stores.push(ledger);
    const rows = [
      entry({ id: "usage-t-main", turnId: "t", role: "main", threads: 1 }),
      entry({ id: "usage-t-sub", turnId: "t", role: "subagent", threads: 3, model: "chat" })
    ];
    ledger.appendMany(rows);
    ledger.appendMany(rows.map((row) => ({ ...row, usage: usage(999, 999) })));
    expect(ledger.perSessionTotals("lab-chat")).toEqual({ turns: 1, usage: usage(20, 2) });
    expect(ledger.perSessionHistory("lab-chat")).toHaveLength(2);
  });
});

describe("daemon per-session cost limit", () => {
  it("forwards a bounded limit query parameter to the history", async () => {
    const dataDir = await createTempDir("puppenclaw-cost-limit-");
    const seed = await UsageLedgerStore.open(join(dataDir, "usage"));
    for (let index = 0; index < 30; index += 1) {
      seed.append(entry({
        id: `usage-${String(index).padStart(3, "0")}`,
        sessionName: "purged",
        timestamp: `2026-09-01T00:00:${String(index).padStart(2, "0")}.000Z`
      }));
    }
    seed.close();
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand(), daemonAuthToken: "cost-limit-token" }),
      dataDir
    });
    const history = async (query: string) => {
      const response = await app.inject({
        method: "GET",
        url: `/session/purged/cost${query}`,
        headers: { authorization: "Bearer cost-limit-token" }
      });
      expect(response.statusCode).toBe(200);
      const details = JSON.parse(response.body).details as { history: unknown[]; turns: number };
      expect(details.turns).toBe(30);
      return details.history.length;
    };
    try {
      expect(await history("")).toBe(20);
      expect(await history("?format=json&limit=25")).toBe(25);
      expect(await history("?limit=1000")).toBe(30);
      expect(await history("?limit=999999")).toBe(30);
      expect(await history("?limit=0")).toBe(1);
      expect(await history("?limit=abc")).toBe(20);
      expect(await history("?limit=-5")).toBe(20);
    } finally {
      await app.close();
    }
  });
});
