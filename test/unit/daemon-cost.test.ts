import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDaemonServer } from "../../src/daemon/server.js";
import { UsageLedgerStore } from "../../src/shared/usage-ledger.js";
import type { UsageLedgerEntry } from "../../src/shared/types.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

function makeEntry(overrides: Partial<UsageLedgerEntry> = {}): UsageLedgerEntry {
  return {
    id: "usage-0001",
    sessionName: "purged-one-shot",
    agent: "claude",
    provider: "anthropic",
    model: "claude-opus",
    usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3, total: 128 },
    durationMs: 1200,
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("daemon per-session cost", () => {
  it("serves a purged session's cost from the durable ledger and keeps unknown names 404", async () => {
    const dataDir = await createTempDir("puppenclaw-daemon-cost-");
    const acpxCommand = await resolveFakeAcpxCommand();

    // Seed the durable ledger before the daemon opens it: two turns for a
    // session that no registry record exists for (the purged one-shot case),
    // plus a second session so a scope bug (aggregating beyond the exact
    // session name) breaks the totals below.
    const seedLedger = await UsageLedgerStore.open(join(dataDir, "usage"));
    seedLedger.append(
      makeEntry({
        id: "usage-0001",
        usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3, total: 128 },
        timestamp: "2026-01-01T00:00:00.000Z"
      })
    );
    seedLedger.append(
      makeEntry({
        id: "usage-0002",
        model: "claude-sonnet",
        usage: { input: 50, output: 10, cacheRead: 2, cacheWrite: 1, total: 63 },
        stopReason: "end_turn",
        timestamp: "2026-01-02T00:00:00.000Z"
      })
    );
    seedLedger.append(
      makeEntry({
        id: "usage-0003",
        sessionName: "other-session",
        provider: "openai",
        model: "gpt-5",
        usage: { input: 9, output: 4, cacheRead: 0, cacheWrite: 0, total: 13 },
        timestamp: "2026-01-03T00:00:00.000Z"
      })
    );
    seedLedger.close();

    const { app } = await createDaemonServer({
      config: makeConfig({
        acpxCommand,
        daemonAuthToken: "secret-token"
      }),
      dataDir
    });

    try {
      // Auth semantics are unchanged: the ledger fallback stays behind the
      // same bearer guard as the live-session path.
      const unauthorized = await app.inject({
        method: "GET",
        url: "/session/purged-one-shot/cost"
      });
      expect(unauthorized.statusCode).toBe(401);
      expect(JSON.parse(unauthorized.body)).toEqual({ ok: false, error: "unauthorized" });

      const response = await app.inject({
        method: "GET",
        url: "/session/purged-one-shot/cost",
        headers: { authorization: "Bearer secret-token" }
      });
      expect(response.statusCode).toBe(200);
      const details = (JSON.parse(response.body) as { details: Record<string, unknown> }).details;
      expect(details.name).toBe("purged-one-shot");
      expect(details.ledgerOnly).toBe(true);
      expect(details.lastCall).toBeNull();
      expect(details.pricing).toBeNull();
      // Provider/model come from the most recent ledger turn.
      expect(details.provider).toBe("anthropic");
      expect(details.model).toBe("claude-sonnet");
      // Aggregation is scoped to the exact session name.
      expect(details.turns).toBe(2);
      expect(details.totals).toEqual({
        turns: 2,
        usage: { input: 150, output: 30, cacheRead: 7, cacheWrite: 4, total: 191 }
      });
      // Turn list is newest-first with the stable ledger ids intact.
      const history = details.history as UsageLedgerEntry[];
      expect(history.map((entry) => entry.id)).toEqual(["usage-0002", "usage-0001"]);
      expect(history[0]).toEqual(
        makeEntry({
          id: "usage-0002",
          model: "claude-sonnet",
          usage: { input: 50, output: 10, cacheRead: 2, cacheWrite: 1, total: 63 },
          stopReason: "end_turn",
          timestamp: "2026-01-02T00:00:00.000Z"
        })
      );

      // Repeated calls return an identical payload (reconcile re-runs).
      const repeat = await app.inject({
        method: "GET",
        url: "/session/purged-one-shot/cost",
        headers: { authorization: "Bearer secret-token" }
      });
      expect(repeat.statusCode).toBe(200);
      expect(repeat.body).toBe(response.body);

      // A name absent from both the registry and the ledger still 404s.
      const unknown = await app.inject({
        method: "GET",
        url: "/session/never-existed/cost",
        headers: { authorization: "Bearer secret-token" }
      });
      expect(unknown.statusCode).toBe(404);
      expect(JSON.parse(unknown.body)).toEqual({
        ok: false,
        code: "NO_SESSION",
        error: "Unknown session never-existed."
      });
    } finally {
      await app.close();
    }
  });

  it("names a purged session after its main model when a turn also recorded subagent rows", async () => {
    const dataDir = await createTempDir("puppenclaw-daemon-cost-models-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const seedLedger = await UsageLedgerStore.open(join(dataDir, "usage"));
    // Both rows share the turn timestamp; the subagent id sorts after the
    // main id, so history lists the subagent row first.
    seedLedger.append(
      makeEntry({
        id: "usage-turn-1-main-aaaa",
        agent: "codex",
        provider: "remote_langdock_gpt6_luna_xhigh",
        model: "gpt-6-luna",
        turnId: "turn-1",
        role: "main",
        threads: 1
      })
    );
    seedLedger.append(
      makeEntry({
        id: "usage-turn-1-subagent-bbbb",
        agent: "codex",
        provider: "remote_langdock_gpt6_luna_xhigh",
        model: "chat",
        turnId: "turn-1",
        role: "subagent",
        threads: 4
      })
    );
    seedLedger.close();

    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand, daemonAuthToken: "secret-token" }),
      dataDir
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/session/purged-one-shot/cost",
        headers: { authorization: "Bearer secret-token" }
      });
      expect(response.statusCode).toBe(200);
      const details = (JSON.parse(response.body) as { details: Record<string, unknown> }).details;
      expect((details.history as UsageLedgerEntry[])[0]?.role).toBe("subagent");
      expect(details.model).toBe("gpt-6-luna");
      expect(details.turns).toBe(1);
    } finally {
      await app.close();
    }
  });
});
