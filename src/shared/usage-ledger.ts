import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import type { NormalizedUsage, UsageLedgerEntry } from "./types.js";
import { ensureDir } from "./utils.js";

const NODE_SQLITE_SPECIFIER = `node${":sqlite"}`;

export type UsageTotals = {
  turns: number;
  usage: NormalizedUsage;
};

export type ModelUsageRollup = UsageTotals & {
  provider: string;
  model: string;
};

export const MAX_LEDGER_PAGE_ROWS = 1_000;

export type UsageLedgerPage = {
  /** Identity of this ledger file; a change means every cursor must restart at 0. */
  ledgerId: string;
  rows: Array<UsageLedgerEntry & { seq: number }>;
  /** Pass as `afterId` to continue; equals the input cursor when the page is empty. */
  next: number;
  hasMore: boolean;
  /** Highest seq written so far. */
  head: number;
};

function zeroUsage(): NormalizedUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function toInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/**
 * One turn may be stored as several per-model rows sharing a payload turnId;
 * legacy rows have none and remain one turn each (their unique row id).
 */
const TURN_COUNT_SQL = "COUNT(DISTINCT COALESCE(json_extract(payload, '$.turnId'), id))";

/**
 * Durable, append-only per-turn token ledger backed by its own SQLite database.
 *
 * It is deliberately a separate store from `SessionStore` (state.json) so that
 * `AcpxSessionManager.purge()` / `gc()` — which only remove session records —
 * never delete usage history. Writes are single-row INSERTs (no read-modify-
 * write), so a concurrent purge/gc cannot lose a just-recorded turn.
 */
export class UsageLedgerStore {
  private ledgerIdValue = "";

  private constructor(
    private readonly db: DatabaseSyncType,
    readonly rootDir: string
  ) {}

  /**
   * Rows are append-only and never deleted, so SQLite's rowid is a gap-free,
   * insertion-ordered cursor (`seq`). The ledger id lives in a side table that
   * older daemons ignore.
   */
  get ledgerId(): string {
    return this.ledgerIdValue;
  }

  static async open(rootDir: string): Promise<UsageLedgerStore> {
    await ensureDir(rootDir);
    const { DatabaseSync } = await import(NODE_SQLITE_SPECIFIER);
    const db = new DatabaseSync(join(rootDir, "usage.sqlite"));
    const store = new UsageLedgerStore(db, rootDir);
    store.migrate();
    return store;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_ledger (
        id TEXT PRIMARY KEY,
        session_name TEXT NOT NULL,
        agent TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        ts TEXT NOT NULL,
        input INTEGER NOT NULL,
        output INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        cache_write INTEGER NOT NULL,
        total INTEGER NOT NULL,
        stop_reason TEXT,
        duration_ms INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_ledger(session_name);
      CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_ledger(provider, model);
      CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_ledger(ts);
      CREATE TABLE IF NOT EXISTS usage_ledger_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ledger_id TEXT NOT NULL
      );
    `);
    this.db.prepare("INSERT OR IGNORE INTO usage_ledger_meta (id, ledger_id) VALUES (1, ?)").run(randomUUID());
    this.ledgerIdValue = String(
      (this.db.prepare("SELECT ledger_id FROM usage_ledger_meta WHERE id = 1").get() as { ledger_id: string })
        .ledger_id
    );
  }

  /** Rows after `afterSeq` in insertion order (GET /usage/ledger). */
  page(afterSeq: number, limit: number): UsageLedgerPage {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), MAX_LEDGER_PAGE_ROWS));
    const rows = this.db
      .prepare("SELECT rowid AS seq, payload FROM usage_ledger WHERE rowid > ? ORDER BY rowid LIMIT ?")
      .all(afterSeq, bounded + 1) as Array<{ seq: number; payload: string }>;
    const page = rows.slice(0, bounded).map((row) => ({
      ...(JSON.parse(row.payload) as UsageLedgerEntry),
      seq: Number(row.seq)
    }));
    const head = Number(
      (this.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS head FROM usage_ledger").get() as { head: number }).head
    );
    return {
      ledgerId: this.ledgerIdValue,
      rows: page,
      next: page.at(-1)?.seq ?? afterSeq,
      hasMore: rows.length > bounded,
      head
    };
  }

  /** The seq of a ledger row id, so a consumer can resume from a row it already holds. */
  seqForId(id: string): number | null {
    const row = this.db.prepare("SELECT rowid AS seq FROM usage_ledger WHERE id = ?").get(id) as
      | { seq: number }
      | undefined;
    return row == null ? null : Number(row.seq);
  }

  close(): void {
    this.db.close();
  }

  /** Appends all rows of one turn atomically; existing ids are left untouched. */
  appendMany(entries: readonly UsageLedgerEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) {
        this.append(entry);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  append(entry: UsageLedgerEntry): void {
    this.db
      .prepare(
        `INSERT INTO usage_ledger
          (id, session_name, agent, provider, model, ts, input, output, cache_read, cache_write, total, stop_reason, duration_ms, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(
        entry.id,
        entry.sessionName,
        entry.agent,
        entry.provider,
        entry.model,
        entry.timestamp,
        entry.usage.input,
        entry.usage.output,
        entry.usage.cacheRead,
        entry.usage.cacheWrite,
        entry.usage.total,
        entry.stopReason ?? null,
        entry.durationMs,
        JSON.stringify(entry)
      );
  }

  perSessionTotals(sessionName: string): UsageTotals {
    const row = this.db
      .prepare(
        `SELECT ${TURN_COUNT_SQL} AS turns,
                SUM(input) AS input, SUM(output) AS output,
                SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
                SUM(total) AS total
         FROM usage_ledger WHERE session_name = ?`
      )
      .get(sessionName) as Record<string, unknown> | undefined;
    return this.rowToTotals(row);
  }

  perSessionHistory(sessionName: string, limit = 50): UsageLedgerEntry[] {
    const bounded = Math.max(1, Math.min(limit, 1000));
    return this.db
      .prepare(
        "SELECT payload FROM usage_ledger WHERE session_name = ? ORDER BY ts DESC, id DESC LIMIT ?"
      )
      .all(sessionName, bounded)
      .map((row) => JSON.parse((row as { payload: string }).payload) as UsageLedgerEntry);
  }

  perModelRollup(since?: string): ModelUsageRollup[] {
    const where = since != null ? "WHERE ts >= ?" : "";
    const args = since != null ? [since] : [];
    const rows = this.db
      .prepare(
        `SELECT provider, model, ${TURN_COUNT_SQL} AS turns,
                SUM(input) AS input, SUM(output) AS output,
                SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
                SUM(total) AS total
         FROM usage_ledger ${where}
         GROUP BY provider, model
         ORDER BY total DESC`
      )
      .all(...args) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      provider: String(row["provider"] ?? "unknown"),
      model: String(row["model"] ?? "unknown"),
      ...this.rowToTotals(row)
    }));
  }

  grandTotals(since?: string): UsageTotals {
    const where = since != null ? "WHERE ts >= ?" : "";
    const args = since != null ? [since] : [];
    const row = this.db
      .prepare(
        `SELECT ${TURN_COUNT_SQL} AS turns,
                SUM(input) AS input, SUM(output) AS output,
                SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
                SUM(total) AS total
         FROM usage_ledger ${where}`
      )
      .get(...args) as Record<string, unknown> | undefined;
    return this.rowToTotals(row);
  }

  private rowToTotals(row: Record<string, unknown> | undefined): UsageTotals {
    if (row == null) {
      return { turns: 0, usage: zeroUsage() };
    }
    return {
      turns: toInt(row["turns"]),
      usage: {
        input: toInt(row["input"]),
        output: toInt(row["output"]),
        cacheRead: toInt(row["cache_read"]),
        cacheWrite: toInt(row["cache_write"]),
        total: toInt(row["total"])
      }
    };
  }
}
