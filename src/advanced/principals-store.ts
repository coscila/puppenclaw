import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";

import type { PrincipalGrants, PrincipalKind, PrincipalRecord, PrincipalUsage } from "./principals-schema.js";

/**
 * Durable run principals (plan P3) in their own file, `principals.sqlite`, next
 * to their sockets. Daemons that predate principals never open it, so a
 * rollback keeps working; advanced.sqlite is not touched.
 */

type Row = {
  id: string; kind: string; run_id: string | null; owner_key: string; grants: string; socket: number; socket_dir: string | null;
  revision: number; created_at: string; updated_at: string; revoked_at: string | null;
};
export type PrincipalAuditEntry = { seq: number; at: string; action: "created" | "updated" | "revoked"; before: unknown; after: unknown };
const SCHEMA_VERSION = "1";
/** The grants an erased principal record keeps: none. */
const ERASED_GRANTS: PrincipalGrants = { providers: [], instruments: [], maxConcurrency: 1, maxItems: 0, tokenBudget: null, expiresAt: null };

function record(row: Row): PrincipalRecord {
  return {
    id: row.id, kind: row.kind as PrincipalKind, runId: row.run_id, ownerKey: row.owner_key, grants: JSON.parse(row.grants) as PrincipalGrants,
    socket: row.socket === 1, socketDir: row.socket_dir, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, revokedAt: row.revoked_at
  };
}

export class PrincipalStore {
  private constructor(private readonly db: Database) {}

  static async open(root: string): Promise<PrincipalStore> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const { DatabaseSync } = await import(`node${":sqlite"}`);
    const path = join(root, "principals.sqlite"), db = new DatabaseSync(path) as Database;
    await chmod(path, 0o600);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON");
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS principals (id TEXT PRIMARY KEY, kind TEXT NOT NULL, run_id TEXT, owner_key TEXT NOT NULL, grants TEXT NOT NULL,
        socket INTEGER NOT NULL, socket_dir TEXT UNIQUE, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT);
      CREATE INDEX IF NOT EXISTS principals_owner ON principals(owner_key);
      CREATE TABLE IF NOT EXISTS principal_usage (principal_id TEXT PRIMARY KEY REFERENCES principals(id), items INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS principal_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, principal_id TEXT NOT NULL, at TEXT NOT NULL,
        action TEXT NOT NULL, before TEXT, after TEXT);
      CREATE INDEX IF NOT EXISTS principal_audit_id ON principal_audit(principal_id, seq);
      CREATE TABLE IF NOT EXISTS principal_item_charges (principal_id TEXT NOT NULL, lineage TEXT NOT NULL, item_id TEXT NOT NULL, charged_at TEXT NOT NULL,
        PRIMARY KEY(principal_id, lineage, item_id)) WITHOUT ROWID;`);
    const version = db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
    if (version && version.value !== SCHEMA_VERSION) {
      db.close();
      throw new Error(`principals.sqlite has schema ${version.value}; this daemon reads schema ${SCHEMA_VERSION}.`);
    }
    db.prepare("INSERT OR IGNORE INTO meta VALUES ('schema', ?)").run(SCHEMA_VERSION);
    return new PrincipalStore(db);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = operation(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  all(): PrincipalRecord[] {
    return (this.db.prepare("SELECT * FROM principals ORDER BY created_at, id").all() as Row[]).map(record);
  }

  get(id: string): PrincipalRecord | null {
    const row = this.db.prepare("SELECT * FROM principals WHERE id=?").get(id) as Row | undefined;
    return row ? record(row) : null;
  }

  idsByOwner(ownerKey: string): string[] {
    return (this.db.prepare("SELECT id FROM principals WHERE owner_key=? ORDER BY id").all(ownerKey) as { id: string }[]).map((row) => row.id);
  }

  /** Writes the record and its audit entry in one transaction. */
  save(next: PrincipalRecord, audit: { action: "created" | "updated"; before: unknown; after: unknown }): void {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO principals (id,kind,run_id,owner_key,grants,socket,socket_dir,revision,created_at,updated_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET grants=excluded.grants, socket=excluded.socket, socket_dir=excluded.socket_dir, revision=excluded.revision, updated_at=excluded.updated_at`)
        .run(next.id, next.kind, next.runId, next.ownerKey, JSON.stringify(next.grants), next.socket ? 1 : 0, next.socketDir, next.revision, next.createdAt, next.updatedAt, next.revokedAt);
      this.db.prepare("INSERT OR IGNORE INTO principal_usage (principal_id) VALUES (?)").run(next.id);
      this.appendAudit(next.id, next.updatedAt, audit.action, audit.before, audit.after);
    });
  }

  revoke(id: string, revokedAt: string, before: unknown): void {
    this.transaction(() => {
      this.db.prepare("UPDATE principals SET revoked_at=?, updated_at=? WHERE id=? AND revoked_at IS NULL").run(revokedAt, revokedAt, id);
      this.appendAudit(id, revokedAt, "revoked", before, { revokedAt });
    });
  }

  /**
   * Account erasure of a revoked principal: only a tombstone stays (id, kind, timestamps, revocation), so the id
   * remains unusable; the owner key, run binding, grants, usage, counted items and audit go.
   */
  erase(id: string): boolean {
    return this.transaction(() => {
      const erased = Number(this.db.prepare("UPDATE principals SET owner_key='', run_id=NULL, grants=?, socket=0, socket_dir=NULL WHERE id=? AND revoked_at IS NOT NULL")
        .run(JSON.stringify(ERASED_GRANTS), id).changes) === 1;
      if (!erased) return false;
      this.db.prepare("DELETE FROM principal_usage WHERE principal_id=?").run(id);
      this.db.prepare("DELETE FROM principal_item_charges WHERE principal_id=?").run(id);
      this.db.prepare("DELETE FROM principal_audit WHERE principal_id=?").run(id);
      return true;
    });
  }

  usage(id: string): PrincipalUsage {
    const row = this.db.prepare("SELECT items, input_tokens, output_tokens FROM principal_usage WHERE principal_id=?").get(id) as
      { items: number; input_tokens: number; output_tokens: number } | undefined;
    return row ? { items: row.items, inputTokens: row.input_tokens, outputTokens: row.output_tokens } : { items: 0, inputTokens: 0, outputTokens: 0 };
  }

  /** Whether maxItems already counted this item of the job lineage. */
  charged(id: string, lineage: string, itemId: string): boolean {
    return this.db.prepare("SELECT 1 FROM principal_item_charges WHERE principal_id=? AND lineage=? AND item_id=?").get(id, lineage, itemId) !== undefined;
  }

  /** Counts one item of a job lineage against maxItems, once; false when it was counted before. */
  charge(id: string, lineage: string, itemId: string, at: string): boolean {
    return this.transaction(() => {
      const inserted = Number(this.db.prepare("INSERT OR IGNORE INTO principal_item_charges (principal_id, lineage, item_id, charged_at) VALUES (?,?,?,?)").run(id, lineage, itemId, at).changes) === 1;
      if (inserted) this.db.prepare("UPDATE principal_usage SET items=items+1 WHERE principal_id=?").run(id);
      return inserted;
    });
  }

  /** Returns an item charge (its admission never dispatched a call); false when there was none. */
  refund(id: string, lineage: string, itemId: string): boolean {
    return this.transaction(() => {
      const deleted = Number(this.db.prepare("DELETE FROM principal_item_charges WHERE principal_id=? AND lineage=? AND item_id=?").run(id, lineage, itemId).changes) === 1;
      if (deleted) this.db.prepare("UPDATE principal_usage SET items=MAX(items-1,0) WHERE principal_id=?").run(id);
      return deleted;
    });
  }

  addUsage(id: string, items: number, inputTokens: number, outputTokens: number): void {
    this.db.prepare("UPDATE principal_usage SET items=items+?, input_tokens=input_tokens+?, output_tokens=output_tokens+? WHERE principal_id=?")
      .run(items, inputTokens, outputTokens, id);
  }

  audit(id: string, limit = 50): PrincipalAuditEntry[] {
    const rows = this.db.prepare("SELECT seq, at, action, before, after FROM principal_audit WHERE principal_id=? ORDER BY seq DESC LIMIT ?").all(id, limit) as
      { seq: number; at: string; action: PrincipalAuditEntry["action"]; before: string | null; after: string | null }[];
    return rows.reverse().map((row) => ({ seq: row.seq, at: row.at, action: row.action, before: row.before === null ? null : JSON.parse(row.before), after: row.after === null ? null : JSON.parse(row.after) }));
  }

  private appendAudit(id: string, at: string, action: PrincipalAuditEntry["action"], before: unknown, after: unknown): void {
    this.db.prepare("INSERT INTO principal_audit (principal_id, at, action, before, after) VALUES (?,?,?,?,?)")
      .run(id, at, action, before === undefined || before === null ? null : JSON.stringify(before), after === undefined || after === null ? null : JSON.stringify(after));
  }

  close(): void { this.db.close(); }
}
