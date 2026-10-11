import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";
import type { WorkerJob, UsageReceipt } from "./types.js";

/** Durable jobs and dispatch receipts. Ambiguous dispatched work is never replayed after restart. */
export class AdvancedStore {
  private constructor(private readonly db: Database) {}
  static async open(root: string): Promise<AdvancedStore> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const { DatabaseSync } = await import(`node${":sqlite"}`);
    const path = join(root, "advanced.sqlite");
    const db = new DatabaseSync(path);
    await chmod(path, 0o600);
    db.exec("PRAGMA secure_delete=ON");
    db.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, parent TEXT NOT NULL, attempt TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(parent,attempt,request_key));
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, parent TEXT NOT NULL, attempt TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS receipts_attempt ON receipts(parent,attempt);`);
    return new AdvancedStore(db);
  }
  putJob(job: WorkerJob): void {
    this.db.prepare("INSERT INTO jobs VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload")
      .run(job.jobId, job.parentSessionName, job.attemptId, job.idempotencyKey, job.fingerprint, JSON.stringify(job));
  }
  job(id: string): WorkerJob | null {
    const row = this.db.prepare("SELECT payload FROM jobs WHERE id=?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as WorkerJob : null;
  }
  duplicate(parent: string, attempt: string, key: string): WorkerJob | null {
    const row = this.db.prepare("SELECT payload FROM jobs WHERE parent=? AND attempt=? AND request_key=?").get(parent, attempt, key) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as WorkerJob : null;
  }
  jobs(parent?: string): WorkerJob[] {
    const rows = parent ? this.db.prepare("SELECT payload FROM jobs WHERE parent=? ORDER BY rowid").all(parent) : this.db.prepare("SELECT payload FROM jobs ORDER BY rowid").all();
    return rows.map((r) => JSON.parse((r as { payload: string }).payload) as WorkerJob);
  }
  putReceipt(receipt: UsageReceipt): void {
    this.db.prepare("INSERT INTO receipts VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload")
      .run(receipt.requestId, receipt.parentSessionName, receipt.attemptId, JSON.stringify(receipt));
  }
  receipts(parent?: string, attempt?: string): UsageReceipt[] {
    const rows = parent && attempt ? this.db.prepare("SELECT payload FROM receipts WHERE parent=? AND attempt=? ORDER BY rowid").all(parent, attempt)
      : parent ? this.db.prepare("SELECT payload FROM receipts WHERE parent=? ORDER BY rowid").all(parent) : this.db.prepare("SELECT payload FROM receipts ORDER BY rowid").all();
    return rows.map((r) => JSON.parse((r as { payload: string }).payload) as UsageReceipt);
  }
  recover(): string[] {
    const children: string[] = [];
    for (const job of this.jobs()) {
      if (!["queued", "running"].includes(job.state)) continue;
      if (job.childSessionName) children.push(job.childSessionName);
      job.state = "interrupted"; job.error = "Runner restarted; dispatched work requires an explicit resume."; job.updatedAt = new Date().toISOString();
      for (const result of job.results) if (["queued", "running"].includes(result.state)) { result.state = "interrupted"; result.error = job.error; }
      this.putJob(job);
    }
    for (const receipt of this.receipts()) if (receipt.state === "running") {
      receipt.state = "interrupted"; receipt.usage.quality = receipt.usage.input == null ? "unavailable" : "partial"; receipt.updatedAt = new Date().toISOString(); this.putReceipt(receipt);
    }
    return children;
  }
  ownedParents(owner: string): string[] { return [...new Set([...this.jobs().filter((j) => j.ownerKey === owner).map((j) => j.parentSessionName), ...this.receipts().filter((r) => r.ownerKey === owner).map((r) => r.parentSessionName)])]; }
  purgeSession(name: string): void {
    const jobs = this.jobs().filter((j) => j.parentSessionName === name || j.childSessionName === name); const ids = new Set(jobs.map((j) => j.jobId));
    this.db.exec("BEGIN IMMEDIATE");
    try { for (const receipt of this.receipts()) if (receipt.parentSessionName === name || receipt.sessionName === name || receipt.jobId && ids.has(receipt.jobId)) this.db.prepare("DELETE FROM receipts WHERE id=?").run(receipt.requestId);
      for (const job of jobs) this.db.prepare("DELETE FROM jobs WHERE id=?").run(job.jobId); this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.db.close(); }
}
