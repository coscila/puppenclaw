import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { ensureDir } from "../shared/utils.js";
import type { RunnerTurnStatistics, StatisticsPage } from "./types.js";

const SQLITE = `node${":sqlite"}`;
/** Durable latest-value journal. Every replacement advances its global cursor. */
export class TurnStatisticsStore {
  readonly daemonId: string;
  private constructor(private readonly db: DatabaseSyncType) {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS statistics_meta (id INTEGER PRIMARY KEY CHECK(id=1), daemon_id TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turn_statistics (id TEXT PRIMARY KEY, revision INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL);
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
