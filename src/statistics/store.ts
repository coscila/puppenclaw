import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { ensureDir } from "../shared/utils.js";
import { PuppenclawError } from "../shared/errors.js";
import type { RunnerTurnStatistics, StatisticsPage } from "./types.js";

const SQLITE = `node${":sqlite"}`;
/** Durable latest-value journal. Every replacement advances its global cursor. */
export class TurnStatisticsStore {
  readonly daemonId: string;
  private constructor(private readonly db: DatabaseSyncType) {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS statistics_meta (id INTEGER PRIMARY KEY CHECK(id=1), daemon_id TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turn_statistics (id TEXT PRIMARY KEY, revision INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS statistics_erasure_fences (chat_hash TEXT PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS statistics_revision ON turn_statistics(revision);`);
    db.prepare("INSERT OR IGNORE INTO statistics_meta VALUES (1, ?, 0)").run(
      randomUUID(),
    );
    this.daemonId = String(
      (
        db
          .prepare("SELECT daemon_id FROM statistics_meta WHERE id=1")
          .get() as { daemon_id: string }
      ).daemon_id,
    );
  }
  static async open(root: string): Promise<TurnStatisticsStore> {
    await ensureDir(root);
    const { DatabaseSync } = await import(SQLITE);
    return new TurnStatisticsStore(
      new DatabaseSync(join(root, "statistics.sqlite")),
    );
  }
  get(id: string): RunnerTurnStatistics | null {
    const row = this.db
      .prepare("SELECT payload FROM turn_statistics WHERE id=?")
      .get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as RunnerTurnStatistics) : null;
  }
  put(value: RunnerTurnStatistics): RunnerTurnStatistics {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.db
          .prepare("SELECT 1 FROM statistics_erasure_fences WHERE chat_hash=?")
          .get(this.chatHash(value.chatId))
      ) {
        throw new PuppenclawError(
          "STATISTICS_CONTEXT_PURGED",
          "Statistics for this chat were permanently erased.",
        );
      }
      const revision = (
        this.db
          .prepare(
            "UPDATE statistics_meta SET revision=revision+1 WHERE id=1 RETURNING revision",
          )
          .get() as { revision: number }
      ).revision;
      if (!Number.isSafeInteger(revision))
        throw new Error("Statistics cursor exhausted");
      const next = { ...value, revision: String(revision) };
      this.db
        .prepare(
          "INSERT INTO turn_statistics VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",
        )
        .run(next.id, revision, JSON.stringify(next));
      this.db.exec("COMMIT");
      return next;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private chatHash(chatId: string): string {
    return createHash("sha256")
      .update(`conversation-statistics-erasure-v1:${chatId}`)
      .digest("hex");
  }
  /** Permanent chat erasure only. Runtime rotation and TTL cleanup must not call this. */
  purgeChat(chatId: string): number {
    this.db.exec("BEGIN IMMEDIATE");
    let removed: number;
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO statistics_erasure_fences VALUES (?)")
        .run(this.chatHash(chatId));
      removed = Number(
        this.db
          .prepare(
            "DELETE FROM turn_statistics WHERE json_extract(payload, '$.chatId')=?",
          )
          .run(chatId).changes,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    // Secure deletion overwrites vacated pages; checkpointing drops old WAL
    // frames. Neither operation rewinds the stable daemon revision cursor.
    const checkpoint = this.db
      .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
      .get() as { busy: number };
    if (checkpoint.busy !== 0)
      throw new Error(
        "Statistics erasure checkpoint is busy; retry after readers settle",
      );
    return removed;
  }
  page(cursor = "0", limit = 100): StatisticsPage {
    if (
      !/^(0|[1-9][0-9]{0,15})$/.test(cursor) ||
      !Number.isSafeInteger(Number(cursor)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new RangeError("Invalid statistics cursor or limit");
    const rows = this.db
      .prepare(
        "SELECT payload FROM turn_statistics WHERE revision>? ORDER BY revision LIMIT ?",
      )
      .all(Number(cursor), limit + 1) as Array<{ payload: string }>;
    const turns = rows
      .slice(0, limit)
      .map((row) => JSON.parse(row.payload) as RunnerTurnStatistics);
    return {
      version: 1,
      daemonId: this.daemonId,
      nextCursor: turns.at(-1)?.revision ?? cursor,
      hasMore: rows.length > limit,
      turns,
    };
  }
  /** No wall-clock extrapolation through a daemon outage. Keep the last durable observation. */
  recoverInterrupted(): void {
    const rows = this.db
      .prepare("SELECT payload FROM turn_statistics")
      .all() as Array<{ payload: string }>;
    for (const item of rows) {
      const row = JSON.parse(item.payload) as RunnerTurnStatistics;
      if (row.state !== "running") continue;
      this.put({
        ...row,
        state: "interrupted",
        finishedAt: row.updatedAt,
        runtimeQuality: "partial",
        tokens: {
          ...row.tokens,
          quality:
            row.tokens.quality === "unavailable" ? "unavailable" : "partial",
        },
        coverageReasons: [
          ...new Set([...row.coverageReasons, "daemon_restart"]),
        ],
        cpu: {
          ...row.cpu,
          coverageReasons: [
            ...new Set([...row.cpu.coverageReasons, "daemon_restart"]),
          ],
        },
      });
    }
  }
  close(): void {
    this.db.close();
  }
}
