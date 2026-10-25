import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";
import type { WorkerJob, WorkerJobHeader, UsageReceipt, ItemResult, BulkSubmit, JobProgress, JobState, PageOptions, ResultPage } from "./types.js";

type StoredRow = { payload: string; revision: number };
const states: JobState[] = ["queued", "running", "paused", "completed", "failed", "cancelled", "interrupted"];
export function pageOptions(options: PageOptions = {}): Required<PageOptions> {
  const { after = 0, limit = 100 } = options;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("Invalid worker cursor or page size (1–1000).");
  return { after, limit };
}
function header(job: WorkerJob): WorkerJobHeader {
  const { results: _results, request, ...metadata } = job;
  if (job.kind === "bulk") { const { items: _items, ...settings } = request as BulkSubmit; return { ...metadata, request: settings }; }
  return { ...metadata, request };
}

/** Durable item rows and dispatch receipts; ambiguous dispatched work is never replayed. */
export class AdvancedStore {
  private constructor(private readonly db: Database) {}
  static async open(root: string): Promise<AdvancedStore> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const { DatabaseSync } = await import(`node${":sqlite"}`);
    const path = join(root, "advanced.sqlite"), db = new DatabaseSync(path);
    await chmod(path, 0o600);
    db.exec("PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON");
    db.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, parent TEXT NOT NULL, attempt TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(parent,attempt,request_key));
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, parent TEXT NOT NULL, attempt TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS receipts_attempt ON receipts(parent,attempt);
      CREATE TABLE IF NOT EXISTS change_sequence (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
      INSERT OR IGNORE INTO change_sequence VALUES (1,0);`);
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!columns("jobs").includes("revision")) db.exec("ALTER TABLE jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
      if (!columns("jobs").includes("storage_version")) db.exec("ALTER TABLE jobs ADD COLUMN storage_version INTEGER NOT NULL DEFAULT 0");
      if (!columns("receipts").includes("job_id")) db.exec("ALTER TABLE receipts ADD COLUMN job_id TEXT; ALTER TABLE receipts ADD COLUMN item_id TEXT; UPDATE receipts SET job_id=json_extract(payload,'$.jobId'), item_id=json_extract(payload,'$.itemId')");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
    db.exec(`CREATE TABLE IF NOT EXISTS job_items (job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, item_id TEXT NOT NULL, ordinal INTEGER NOT NULL, input TEXT, result TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(job_id,item_id));
      CREATE INDEX IF NOT EXISTS jobs_parent_revision ON jobs(parent,revision);
      CREATE INDEX IF NOT EXISTS items_revision ON job_items(job_id,revision);
      CREATE INDEX IF NOT EXISTS items_order ON job_items(job_id,ordinal);
      CREATE INDEX IF NOT EXISTS items_state ON job_items(job_id,state);
      CREATE INDEX IF NOT EXISTS receipts_item ON receipts(job_id,item_id);`);
    const store = new AdvancedStore(db);
    // Each migration is atomic. Old idempotency keys and completed results are retained.
    for (const row of db.prepare("SELECT payload FROM jobs WHERE storage_version=0").all() as { payload: string }[]) store.putJob(JSON.parse(row.payload) as WorkerJob);
    return store;
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = operation(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private revision(): number { return (this.db.prepare("UPDATE change_sequence SET value=value+1 WHERE id=1 RETURNING value").get() as { value: number }).value; }
  private saveHeader(job: WorkerJobHeader, revision: number): void {
    this.db.prepare("INSERT INTO jobs (id,parent,attempt,request_key,fingerprint,payload,revision,storage_version) VALUES (?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision,storage_version=1")
      .run(job.jobId, job.parentSessionName, job.attemptId, job.idempotencyKey, job.fingerprint, JSON.stringify(job), revision);
  }
  putJob(job: WorkerJob): void {
    this.transaction(() => {
      let revision = this.revision();
      this.saveHeader(header(job), revision);
      const items = job.kind === "bulk" ? (job.request as BulkSubmit).items : [];
      const save = this.db.prepare("INSERT INTO job_items VALUES (?,?,?,?,?,?,?) ON CONFLICT(job_id,item_id) DO UPDATE SET result=excluded.result,state=excluded.state,revision=excluded.revision WHERE job_items.result<>excluded.result");
      for (const [ordinal, result] of job.results.entries()) {
        revision = this.revision();
        save.run(job.jobId, result.id, ordinal, items[ordinal] ? JSON.stringify(items[ordinal]!.input) : null, JSON.stringify(result), result.state, revision);
      }
      this.db.prepare("UPDATE jobs SET revision=? WHERE id=?").run(revision, job.jobId);
    });
  }
  jobHeader(id: string): WorkerJobHeader | null {
    const row = this.db.prepare("SELECT payload FROM jobs WHERE id=?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as WorkerJobHeader : null;
  }
  jobHeaders(parent?: string, attempt?: string): WorkerJobHeader[] {
    const rows = parent && attempt ? this.db.prepare("SELECT payload FROM jobs WHERE parent=? AND attempt=? ORDER BY rowid").all(parent, attempt)
      : parent ? this.db.prepare("SELECT payload FROM jobs WHERE parent=? ORDER BY rowid").all(parent) : this.db.prepare("SELECT payload FROM jobs ORDER BY rowid").all();
    return rows.map((r) => JSON.parse((r as { payload: string }).payload) as WorkerJobHeader);
  }
  updateHeader(id: string, patch: Partial<Pick<WorkerJobHeader, "state" | "error" | "updatedAt">>): WorkerJobHeader {
    return this.transaction(() => { const job = this.jobHeader(id); if (!job) throw new Error("Worker job is missing."); Object.assign(job, patch); this.saveHeader(job, this.revision()); return job; });
  }
  item(id: string, itemId: string): ItemResult | null {
    const row = this.db.prepare("SELECT result FROM job_items WHERE job_id=? AND item_id=?").get(id, itemId) as { result: string } | undefined;
    return row ? JSON.parse(row.result) as ItemResult : null;
  }
  updateItem(id: string, itemId: string, patch: Partial<Omit<ItemResult, "id">>): ItemResult {
    return this.transaction(() => {
      const item = this.item(id, itemId), job = this.jobHeader(id);
      if (!item || !job) throw new Error("Worker result is missing.");
      Object.assign(item, patch); const revision = this.revision();
      this.db.prepare("UPDATE job_items SET result=?,state=?,revision=? WHERE job_id=? AND item_id=?").run(JSON.stringify(item), item.state, revision, id, itemId);
      job.updatedAt = new Date().toISOString(); this.saveHeader(job, revision);
      return item;
    });
  }
  private hydrate(job: WorkerJobHeader): WorkerJob {
    const rows = this.db.prepare("SELECT item_id,input,result FROM job_items WHERE job_id=? ORDER BY ordinal").all(job.jobId) as { item_id: string; input: string | null; result: string }[];
    const request = job.kind === "bulk" ? { ...job.request, items: rows.map((r) => ({ id: r.item_id, input: JSON.parse(r.input!) as BulkSubmit["items"][number]["input"] })) } as BulkSubmit : job.request as WorkerJob["request"];
    return { ...job, request, results: rows.map((r) => JSON.parse(r.result) as ItemResult) };
  }
  job(id: string): WorkerJob | null { const job = this.jobHeader(id); return job ? this.hydrate(job) : null; }
  duplicate(parent: string, attempt: string, key: string): WorkerJob | null {
    const row = this.db.prepare("SELECT id FROM jobs WHERE parent=? AND attempt=? AND request_key=?").get(parent, attempt, key) as { id: string } | undefined;
    return row ? this.job(row.id) : null;
  }
  jobs(parent?: string): WorkerJob[] { return this.jobHeaders(parent).map((job) => this.hydrate(job)); }
  /** Job counts by state from one scan of the jobs table (ops idle checks). */
  countJobsByState(): Record<JobState, number> {
    const counts = Object.fromEntries(states.map((state) => [state, 0])) as Record<JobState, number>;
    for (const row of this.db.prepare("SELECT json_extract(payload,'$.state') AS state, count(*) AS count FROM jobs GROUP BY 1").all() as { state: string; count: number }[]) {
      if ((states as string[]).includes(row.state)) counts[row.state as JobState] = row.count;
    }
    return counts;
  }
  progress(id: string): JobProgress {
    const progress = { total: 0, ...Object.fromEntries(states.map((state) => [state, 0])) } as JobProgress;
    for (const row of this.db.prepare("SELECT state,count(*) AS count FROM job_items WHERE job_id=? GROUP BY state").all(id) as { state: JobState; count: number }[]) { progress[row.state] = row.count; progress.total += row.count; }
    return progress;
  }
  summaries(parent?: string, options: PageOptions = {}) {
    const { after, limit } = pageOptions(options);
    const rows = (parent ? this.db.prepare("SELECT payload,revision FROM jobs WHERE parent=? AND revision>? ORDER BY revision LIMIT ?").all(parent, after, limit + 1)
      : this.db.prepare("SELECT payload,revision FROM jobs WHERE revision>? ORDER BY revision LIMIT ?").all(after, limit + 1)) as StoredRow[];
    const page = rows.slice(0, limit);
    return { jobs: page.map((r) => { const job = JSON.parse(r.payload) as WorkerJobHeader; return { job, revision: r.revision, progress: this.progress(job.jobId) }; }), nextCursor: page.at(-1)?.revision ?? after, hasMore: rows.length > limit };
  }
  summary(id: string) {
    const row = this.db.prepare("SELECT payload,revision FROM jobs WHERE id=?").get(id) as StoredRow | undefined;
    return row ? { job: JSON.parse(row.payload) as WorkerJobHeader, revision: row.revision, progress: this.progress(id) } : null;
  }
  resultPage(id: string, options: PageOptions = {}): ResultPage {
    const { after, limit } = pageOptions(options);
    const rows = this.db.prepare("SELECT result,revision FROM job_items WHERE job_id=? AND revision>? ORDER BY revision LIMIT ?").all(id, after, limit + 1) as { result: string; revision: number }[];
    const page = rows.slice(0, limit);
    return { jobId: id, results: page.map((r) => ({ ...JSON.parse(r.result) as ItemResult, revision: r.revision })), nextCursor: page.at(-1)?.revision ?? after, hasMore: rows.length > limit };
  }
  putReceipt(receipt: UsageReceipt): void {
    this.db.prepare("INSERT INTO receipts (id,parent,attempt,payload,job_id,item_id) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload")
      .run(receipt.requestId, receipt.parentSessionName, receipt.attemptId, JSON.stringify(receipt), receipt.jobId ?? null, receipt.itemId ?? null);
  }
  itemReceipt(jobId: string, itemId: string): UsageReceipt | null {
    const row = this.db.prepare("SELECT payload FROM receipts WHERE job_id=? AND item_id=? ORDER BY rowid DESC LIMIT 1").get(jobId, itemId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as UsageReceipt : null;
  }
  jobReceipts(jobId: string): UsageReceipt[] {
    const rows = this.db.prepare("SELECT payload FROM receipts WHERE job_id=? ORDER BY rowid").all(jobId) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as UsageReceipt);
  }
  receipts(parent?: string, attempt?: string): UsageReceipt[] {
    const rows = parent && attempt ? this.db.prepare("SELECT payload FROM receipts WHERE parent=? AND attempt=? ORDER BY rowid").all(parent, attempt)
      : parent ? this.db.prepare("SELECT payload FROM receipts WHERE parent=? ORDER BY rowid").all(parent) : this.db.prepare("SELECT payload FROM receipts ORDER BY rowid").all();
    return rows.map((r) => JSON.parse((r as { payload: string }).payload) as UsageReceipt);
  }
  recover(): string[] {
    const children: string[] = [];
    for (const metadata of this.jobHeaders()) {
      if (!["queued", "running"].includes(metadata.state)) continue;
      const job = this.job(metadata.jobId)!;
      if (job.childSessionName) children.push(job.childSessionName);
      job.state = "interrupted"; job.error = "Runner restarted; dispatched work requires an explicit resume."; job.updatedAt = new Date().toISOString();
      for (const result of job.results) if (["queued", "running"].includes(result.state)) { result.state = "interrupted"; result.error = job.error; }
      this.putJob(job);
    }
    const running = this.db.prepare("SELECT payload FROM receipts WHERE json_extract(payload,'$.state')='running'").all() as { payload: string }[];
    for (const row of running) {
      const receipt = JSON.parse(row.payload) as UsageReceipt;
      receipt.state = "interrupted"; receipt.usage.quality = receipt.usage.input == null ? "unavailable" : "partial"; receipt.updatedAt = new Date().toISOString(); this.putReceipt(receipt);
    }
    return children;
  }
  ownedParents(owner: string): string[] { return [...new Set([...this.jobHeaders().filter((j) => j.ownerKey === owner).map((j) => j.parentSessionName), ...this.receipts().filter((r) => r.ownerKey === owner).map((r) => r.parentSessionName)])]; }
  purgeSession(name: string): void {
    const jobs = this.jobHeaders().filter((j) => j.parentSessionName === name || j.childSessionName === name); const ids = new Set(jobs.map((j) => j.jobId));
    this.transaction(() => {
      for (const receipt of this.receipts()) if (receipt.parentSessionName === name || receipt.sessionName === name || receipt.jobId && ids.has(receipt.jobId)) this.db.prepare("DELETE FROM receipts WHERE id=?").run(receipt.requestId);
      for (const job of jobs) this.db.prepare("DELETE FROM jobs WHERE id=?").run(job.jobId);
    });
  }
  close(): void { this.db.close(); }
}
