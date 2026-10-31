import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync as Database, StatementSync } from "node:sqlite";

import {
  BROKER_JOB_EVENT,
  BROKER_RECEIPT_EVENT,
  brokerJobCounts,
  brokerJobPayload,
  brokerReceiptPayload,
  instrumentDigestOf,
  SETTLED_ITEM_STATES,
  type BrokerEvent,
  type BrokerEventType,
  type BrokerJobCounts,
  type BrokerJobPayload
} from "./outbox.js";
import { canonicalJson, effectiveSettings, serverFingerprint, settingsSha256, sha256Hex } from "./fingerprint.js";
import type { WorkerJob, WorkerJobHeader, UsageReceipt, ItemResult, BulkSubmit, JobProgress, JobState, PageOptions, ResultPage } from "./types.js";

type StoredRow = { payload: string; revision: number };
const states: JobState[] = ["queued", "running", "paused", "completed", "failed", "cancelled", "interrupted"];
const SETTLED_SQL = `(${SETTLED_ITEM_STATES.map((state) => `'${state}'`).join(",")})`;
const TERMINAL_JOB_STATES = ["completed", "failed", "cancelled", "interrupted"];

/**
 * Storage era of a job row. 0: whole job in the payload (migrated at open);
 * 1: item rows written before P1; 2: written by P1 (inputs as blobs, outbox).
 * Recovery requeues bulk items of era-2 jobs only. An older daemon that
 * rewrites a header sets 1, which only makes recovery more conservative.
 */
export const P1_STORAGE_VERSION = 2;

/** Default group-commit window (plan P1: at most 50 ms per batch). */
export const DEFAULT_COMMIT_WINDOW_MS = 50;
const DEFAULT_MAX_BATCH = 512;
/** A job header's updatedAt follows item progress at most this often. */
const HEADER_TOUCH_INTERVAL_MS = 1_000;

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

export function commitWindowFromEnvironment(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PUPPENCLAW_ADVANCED_COMMIT_WINDOW_MS;
  if (raw === undefined) return DEFAULT_COMMIT_WINDOW_MS;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value > 50) throw new Error("PUPPENCLAW_ADVANCED_COMMIT_WINDOW_MS must be an integer from 0 to 50.");
  return value;
}

export type AdvancedStoreOptions = {
  /** Group-commit window in ms (0–50); 0 commits every write at once. */
  commitWindowMs?: number;
  /** A batch is committed early once it holds this many writes. */
  maxBatch?: number;
  now?: () => Date;
  /** Diagnostics and tests: called with the connection after the schema is in place. */
  onConnection?: (db: Database) => void;
  warn?: (code: string, error?: unknown) => void;
};

export type FeedPage = { feedId: string; events: BrokerEvent[]; next: number; hasMore: boolean; head: number; acked: number };
export type StoreStats = { batches: number; mutations: number; fallbacks: number; failedMutations: number; duplicateSettlements: number };
export type InstrumentRecord = { digest: string; bundle: Record<string, unknown>; settingsSha256: string; installedAt: string };
/**
 * skipped.historical: written before P1 (their records reach Postgres only through the one-time backfill, which the
 * daemon cannot see; historical rows go only with the author's per-item approval); skipped.run: jobs of a run
 * principal (a run is what a study references).
 */
export type ArchiveReport = { file: string | null; jobs: number; items: number; receipts: number; skipped: { studyRef: number; run: number; historical: number; unacknowledged: number }; manifest: string | null };

type BatchContext = { touched: Set<string>; events: number };
type Mutation = { apply: (batch: BatchContext) => void; after?: () => void; resolve: () => void; reject: (error: unknown) => void };
/**
 * The terminal receipt of one item. `persist` writes the transport receipt row
 * (bulk calls); agent jobs pass an aggregate of receipts already stored.
 */
export type ReceiptSettlement = { receipt: UsageReceipt; event: boolean; persist: boolean; fallbackFingerprint: string; fallbackSettingsSha256: string };

export class FeedCursorError extends Error {
  constructor(readonly code: "INVALID_EVENT_CURSOR" | "FEED_REPLACED", message: string) { super(message); this.name = "FeedCursorError"; }
}

export class InstrumentConflictError extends Error {
  readonly code = "INSTRUMENT_DIGEST_CONFLICT";
  constructor() { super("A different instrument bundle is already installed under this digest."); this.name = "InstrumentConflictError"; }
}

/**
 * Durable item rows, dispatch receipts and the broker outbox (plan P1).
 * - Writes are group-committed: every write joins a batch that commits as one
 *   transaction within commitWindowMs; a failing batch is replayed write by
 *   write so one bad write cannot take the others down.
 * - Every public read first commits pending writes, so readers always see
 *   their own writes. Running item state lives in memory only.
 * - A settled item, its receipt and its outbox row are one write, hence one
 *   transaction: a crash keeps all of them or none.
 * - Item inputs are blobs keyed by the sha256 of their JSON (deduplicated).
 */
export class AdvancedStore {
  private readonly statements = new Map<string, StatementSync>();
  private queue: Mutation[] = [];
  private pendingReceipts = new Map<string, { json: string; receipt: UsageReceipt }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;
  private closed = false;
  private readonly running = new Map<string, Map<string, ItemResult>>();
  private readonly headerTouches = new Map<string, number>();
  private readonly waiters = new Set<{ after: number; wake: () => void }>();
  private headSeq = 0;
  private durableSeq = 0;
  private ackedSeq = 0;
  private readonly feed: string;
  private readonly commitWindowMs: number;
  private readonly maxBatch: number;
  private readonly now: () => Date;
  private readonly warn: (code: string, error?: unknown) => void;
  private readonly indexes: { owner: boolean; child: boolean; state: boolean; running: boolean };
  readonly stats: StoreStats = { batches: 0, mutations: 0, fallbacks: 0, failedMutations: 0, duplicateSettlements: 0 };
  private recovery: { requeued: string[]; relaunch: string[] } = { requeued: [], relaunch: [] };
  private erasuresPending = 0;

  private constructor(private readonly db: Database, private readonly root: string, options: AdvancedStoreOptions, indexes: AdvancedStore["indexes"]) {
    this.commitWindowMs = options.commitWindowMs ?? DEFAULT_COMMIT_WINDOW_MS;
    this.maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH;
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? (() => {});
    this.indexes = indexes;
    const meta = db.prepare("SELECT feed_id, acked FROM outbox_meta WHERE id=1").get() as { feed_id: string; acked: number };
    this.feed = meta.feed_id; this.ackedSeq = Number(meta.acked);
    // Events committed by an earlier process may still sit unsynced in the page cache:
    // the first page served by this process fsyncs them (syncDurable).
    this.headSeq = this.readHead(); this.durableSeq = 0;
  }

  static async open(root: string, options: AdvancedStoreOptions = {}): Promise<AdvancedStore> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const { DatabaseSync } = await import(`node${":sqlite"}`);
    const path = join(root, "advanced.sqlite"), db = new DatabaseSync(path);
    await chmod(path, 0o600);
    // WAL with synchronous=NORMAL: one fsync per checkpoint instead of per commit, and
    // readers never block the writer. secure_delete=FAST zeroes freed pages only when
    // that costs no extra I/O. journal_mode=WAL persists in the file; older daemons
    // open it unchanged. Events are fsynced before they are served (syncDurable).
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA secure_delete=FAST; PRAGMA foreign_keys=ON");
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
      // P1 (additive only: older daemons name their columns on insert, and job_items keeps its seven columns).
      if (!columns("jobs").includes("study_ref")) db.exec("ALTER TABLE jobs ADD COLUMN study_ref TEXT");
      // The outbox columns are the pcp/2 contract names (jobId, itemId, createdAt); a pre-release store named them in snake case.
      if (columns("outbox").includes("job_id")) db.exec("ALTER TABLE outbox RENAME COLUMN job_id TO jobId; ALTER TABLE outbox RENAME COLUMN item_id TO itemId; ALTER TABLE outbox RENAME COLUMN created_at TO createdAt; ALTER TABLE outbox RENAME COLUMN receipt_id TO receiptId");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
    db.exec(`CREATE TABLE IF NOT EXISTS job_items (job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, item_id TEXT NOT NULL, ordinal INTEGER NOT NULL, input TEXT, result TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(job_id,item_id));
      CREATE INDEX IF NOT EXISTS jobs_parent_revision ON jobs(parent,revision);
      CREATE INDEX IF NOT EXISTS items_revision ON job_items(job_id,revision);
      CREATE INDEX IF NOT EXISTS items_order ON job_items(job_id,ordinal);
      CREATE INDEX IF NOT EXISTS items_state ON job_items(job_id,state);
      CREATE INDEX IF NOT EXISTS receipts_item ON receipts(job_id,item_id);
      CREATE TABLE IF NOT EXISTS blobs (digest TEXT PRIMARY KEY, data TEXT NOT NULL, bytes INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS item_inputs (job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, item_id TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(job_id,item_id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS item_inputs_digest ON item_inputs(digest);
      CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, jobId TEXT NOT NULL, itemId TEXT, payload TEXT NOT NULL, createdAt TEXT NOT NULL, receiptId TEXT);
      CREATE INDEX IF NOT EXISTS outbox_job ON outbox(jobId,seq);
      CREATE UNIQUE INDEX IF NOT EXISTS outbox_receipt_item ON outbox(jobId,itemId) WHERE type='broker.receipt';
      CREATE TABLE IF NOT EXISTS outbox_meta (id INTEGER PRIMARY KEY CHECK(id=1), feed_id TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0, acked_at TEXT, synced_revision INTEGER NOT NULL DEFAULT 0, durable_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS erasure_pending (job_id TEXT PRIMARY KEY, session TEXT NOT NULL, owner_key TEXT, requested_at TEXT NOT NULL) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS erasure_pending_session ON erasure_pending(session);
      CREATE INDEX IF NOT EXISTS erasure_pending_owner ON erasure_pending(owner_key);
      CREATE TABLE IF NOT EXISTS instruments (digest TEXT PRIMARY KEY, bundle TEXT NOT NULL, settings_sha256 TEXT NOT NULL, installed_at TEXT NOT NULL) WITHOUT ROWID;`);
    // Expression indexes replace the full scans of owner, child and state lookups. SQLite
    // maintains them for writes by older daemons too. A row that is not JSON would make
    // their creation fail; the lookups then fall back to scans instead of refusing to open.
    const index = (sql: string): boolean => { try { db.exec(sql); return true; } catch { return false; } };
    const indexes = {
      owner: index("CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(json_extract(payload,'$.ownerKey'))") && index("CREATE INDEX IF NOT EXISTS receipts_owner ON receipts(json_extract(payload,'$.ownerKey'))"),
      child: index("CREATE INDEX IF NOT EXISTS jobs_child ON jobs(json_extract(payload,'$.childSessionName'))"),
      state: index("CREATE INDEX IF NOT EXISTS jobs_state ON jobs(json_extract(payload,'$.state'))"),
      running: index("CREATE INDEX IF NOT EXISTS receipts_running ON receipts(id) WHERE json_extract(payload,'$.state')='running'")
    };
    index("CREATE INDEX IF NOT EXISTS items_truncated ON job_items(job_id,state) WHERE json_extract(result,'$.truncated')=1");
    const sequence = () => Number((db.prepare("SELECT value FROM change_sequence WHERE id=1").get() as { value: number }).value);
    // A new outbox starts at the current revision: history before P1 reaches Postgres
    // through the one-time backfill, not through the feed.
    db.prepare("INSERT OR IGNORE INTO outbox_meta (id, feed_id, acked, synced_revision) VALUES (1, ?, 0, ?)").run(randomUUID(), sequence());
    options.onConnection?.(db);
    const store = new AdvancedStore(db, root, options, indexes);
    store.catchUp();
    // Each migration is atomic. Old idempotency keys and completed results are retained.
    for (const row of db.prepare("SELECT payload FROM jobs WHERE storage_version=0").all() as { payload: string }[]) store.applyNow((batch) => store.writeJob(JSON.parse(row.payload) as WorkerJob, batch, {}));
    // A pre-release store deferred whole jobs (purge_deferred): erase their content now and track them like any other.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purge_deferred'").get() !== undefined) {
      store.applyNow(() => {
        for (const row of db.prepare("SELECT job_id FROM purge_deferred").all() as { job_id: string }[]) store.deferErasure(row.job_id);
        db.exec("DROP TABLE purge_deferred");
      });
    }
    store.applyNow(() => store.completeDeferredPurgesIn());
    store.collectOrphanBlobs();
    return store;
  }

  // ---------------------------------------------------------------- plumbing

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  private timestamp(): string { return this.now().toISOString(); }
  private revision(count = 1): number { return Number((this.stmt("UPDATE change_sequence SET value=value+? WHERE id=1 RETURNING value").get(count) as { value: number }).value) - count + 1; }
  private readHead(): number { return Number((this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='outbox'").get() as { seq: number } | undefined)?.seq ?? 0); }

  /** Commits every pending write now (one transaction; write-by-write on failure). */
  flush(): void { this.flushPending(); }

  private enqueue(apply: Mutation["apply"], after?: () => void): Promise<void> {
    if (this.closed) return Promise.reject(new Error("The advanced store is closed."));
    let resolve!: () => void, reject!: (error: unknown) => void;
    const done = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    done.catch(() => {});
    this.queue.push({ apply, ...(after ? { after } : {}), resolve, reject });
    this.schedule();
    return done;
  }

  private schedule(): void {
    if (this.flushing) return;
    if (this.commitWindowMs === 0 || this.queue.length >= this.maxBatch) { this.flushPending(); return; }
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flushPending(); }, this.commitWindowMs);
    this.timer.unref?.();
  }

  private flushPending(): void {
    if (this.flushing || this.queue.length === 0) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.flushing = true;
    const batch = this.queue; this.queue = []; this.pendingReceipts = new Map();
    let notify = false;
    try {
      const context: BatchContext = { touched: new Set(), events: 0 };
      try {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          for (const mutation of batch) mutation.apply(context);
          this.finishBatch(context);
          this.db.exec("COMMIT");
        } catch (error) { this.rollback(); throw error; }
        this.stats.batches += 1; this.stats.mutations += batch.length;
        notify = context.events > 0;
        for (const mutation of batch) { mutation.after?.(); mutation.resolve(); }
      } catch {
        // Replay write by write: only the writes that fail are lost, and each reports its error.
        this.stats.fallbacks += 1;
        for (const mutation of batch) {
          const single: BatchContext = { touched: new Set(), events: 0 };
          try {
            this.db.exec("BEGIN IMMEDIATE");
            try { mutation.apply(single); this.finishBatch(single); this.db.exec("COMMIT"); } catch (error) { this.rollback(); throw error; }
            this.stats.batches += 1; this.stats.mutations += 1;
            notify ||= single.events > 0;
            mutation.after?.(); mutation.resolve();
          } catch (error) {
            this.stats.failedMutations += 1;
            this.warn("ADVANCED_STORE_WRITE_FAILED", error);
            mutation.reject(error);
          }
        }
      }
    } finally {
      this.flushing = false;
    }
    if (notify) { this.headSeq = this.readHead(); this.wakeWaiters(); }
    if (this.queue.length > 0) this.schedule();
  }

  private rollback(): void { try { if (this.db.isTransaction) this.db.exec("ROLLBACK"); } catch { /* the transaction is already gone */ } }

  /** Applies one write in its own transaction immediately (open-time migrations, maintenance). */
  private applyNow(apply: (batch: BatchContext) => void): void {
    this.flushPending();
    const context: BatchContext = { touched: new Set(), events: 0 };
    this.db.exec("BEGIN IMMEDIATE");
    try { apply(context); this.finishBatch(context); this.db.exec("COMMIT"); } catch (error) { this.rollback(); throw error; }
    if (context.events > 0) { this.headSeq = this.readHead(); this.wakeWaiters(); }
  }

  /** Per batch, not per item: bump each touched job's revision once and refresh its updatedAt at most once a second. */
  private finishBatch(context: BatchContext): void {
    if (context.touched.size > 0) {
      const nowMs = this.now().getTime();
      for (const jobId of context.touched) {
        this.stmt("UPDATE jobs SET revision=? WHERE id=?").run(this.revision(), jobId);
        if (nowMs - (this.headerTouches.get(jobId) ?? 0) < HEADER_TOUCH_INTERVAL_MS) continue;
        const row = this.stmt("SELECT payload FROM jobs WHERE id=?").get(jobId) as { payload: string } | undefined;
        if (!row) continue;
        const job = JSON.parse(row.payload) as WorkerJobHeader;
        // updatedAt is a liveness signal of active jobs; a finished job keeps the time it finished.
        if (TERMINAL_JOB_STATES.includes(job.state)) continue;
        job.updatedAt = new Date(nowMs).toISOString();
        this.stmt("UPDATE jobs SET payload=? WHERE id=?").run(JSON.stringify(job), jobId);
        this.headerTouches.set(jobId, nowMs);
      }
    }
    // Everything up to this revision is reflected in the outbox; a larger value at open means
    // an older daemon wrote in between (catchUp).
    this.stmt("UPDATE outbox_meta SET synced_revision=(SELECT value FROM change_sequence WHERE id=1) WHERE id=1").run();
  }

  // ---------------------------------------------------------------- writes

  private saveHeader(job: WorkerJobHeader, revision: number): void {
    this.stmt("INSERT INTO jobs (id,parent,attempt,request_key,fingerprint,payload,revision,storage_version) VALUES (?,?,?,?,?,?,?,2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision,storage_version=CASE jobs.storage_version WHEN 0 THEN 1 ELSE jobs.storage_version END")
      .run(job.jobId, job.parentSessionName, job.attemptId, job.idempotencyKey, job.fingerprint, JSON.stringify(job), revision);
    if (TERMINAL_JOB_STATES.includes(job.state)) this.headerTouches.delete(job.jobId);
    else this.headerTouches.set(job.jobId, this.now().getTime());
  }

  /** `digest`, when given, is sha256Hex of that JSON computed elsewhere (the digest worker), so it is not hashed again here. */
  private saveInput(jobId: string, itemId: string, input: unknown, precomputed?: string): void {
    const data = JSON.stringify(input) ?? "null", digest = precomputed ?? sha256Hex(data);
    this.stmt("INSERT OR IGNORE INTO blobs (digest,data,bytes) VALUES (?,?,?)").run(digest, data, Buffer.byteLength(data));
    this.stmt("INSERT OR IGNORE INTO item_inputs (job_id,item_id,digest) VALUES (?,?,?)").run(jobId, itemId, digest);
  }

  private priorState(jobId: string): JobState | null {
    const row = this.stmt("SELECT json_extract(payload,'$.state') AS state FROM jobs WHERE id=?").get(jobId) as { state: JobState } | undefined;
    return row?.state ?? null;
  }

  /** Header, item rows and outbox rows of one job in the current transaction. */
  private writeJob(job: WorkerJob, batch: BatchContext, extra: { receipts?: ReceiptSettlement[]; inputDigests?: readonly string[] }): void {
    const previous = this.priorState(job.jobId);
    const items = job.kind === "bulk" ? (job.request as BulkSubmit).items : [];
    const first = this.revision(job.results.length + 1);
    this.saveHeader(header(job), first);
    const exists = this.stmt("SELECT 1 FROM job_items WHERE job_id=? AND item_id=?");
    const save = this.stmt("INSERT INTO job_items (job_id,item_id,ordinal,input,result,state,revision) VALUES (?,?,?,NULL,?,?,?) ON CONFLICT(job_id,item_id) DO UPDATE SET result=excluded.result,state=excluded.state,revision=excluded.revision WHERE job_items.result<>excluded.result");
    for (const [ordinal, result] of job.results.entries()) {
      const input = items[ordinal];
      if (input && (previous === null || !exists.get(job.jobId, result.id))) this.saveInput(job.jobId, result.id, input.input, extra.inputDigests?.[ordinal]);
      save.run(job.jobId, result.id, ordinal, JSON.stringify(result), result.state, first + 1 + ordinal);
    }
    this.stmt("UPDATE jobs SET revision=? WHERE id=?").run(first + job.results.length, job.jobId);
    for (const receipt of extra.receipts ?? []) if (receipt.persist) this.writeReceiptRow(receipt.receipt);
    if (previous !== job.state) this.insertJobEvent(header(job), batch);
    for (const settlement of extra.receipts ?? []) {
      if (!settlement.event || !settlement.receipt.itemId) continue;
      const item = job.results.find((result) => result.id === settlement.receipt.itemId);
      if (item) this.insertReceiptEvent(job.jobId, instrumentDigestOf(job), item, settlement, batch);
    }
  }

  private writeReceiptRow(receipt: UsageReceipt, json = JSON.stringify(receipt)): void {
    this.stmt("INSERT INTO receipts (id,parent,attempt,payload,job_id,item_id) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload")
      .run(receipt.requestId, receipt.parentSessionName, receipt.attemptId, json, receipt.jobId ?? null, receipt.itemId ?? null);
  }

  private counts(jobId: string): BrokerJobCounts {
    const byState: Partial<Record<JobState, number>> = {}, truncated: Partial<Record<JobState, number>> = {};
    for (const row of this.stmt("SELECT state,count(*) AS n FROM job_items WHERE job_id=? GROUP BY state").all(jobId) as { state: JobState; n: number }[]) byState[row.state] = Number(row.n);
    for (const row of this.stmt("SELECT state,count(*) AS n FROM job_items WHERE job_id=? AND json_extract(result,'$.truncated')=1 GROUP BY state").all(jobId) as { state: JobState; n: number }[]) truncated[row.state] = Number(row.n);
    return brokerJobCounts(byState, truncated, this.running.get(jobId)?.size ?? 0);
  }

  private insertJobEvent(job: WorkerJobHeader, batch: BatchContext): void {
    const payload = brokerJobPayload(job, this.counts(job.jobId));
    this.stmt("INSERT INTO outbox (type,jobId,itemId,payload,createdAt,receiptId) VALUES (?,?,NULL,?,?,NULL)").run(BROKER_JOB_EVENT, job.jobId, JSON.stringify(payload), this.timestamp());
    batch.events += 1;
  }

  /**
   * At most one receipt event per job and item (a partial unique index backs this).
   * The check comes first because even an ignored insert would consume a seq.
   */
  private insertReceiptEvent(jobId: string, instrumentDigest: string | null, item: ItemResult, settlement: ReceiptSettlement, batch: BatchContext): boolean {
    if (this.stmt("SELECT 1 FROM outbox WHERE jobId=? AND itemId=? AND type='broker.receipt'").get(jobId, item.id) !== undefined) { this.stats.duplicateSettlements += 1; return false; }
    const payload = brokerReceiptPayload({ jobId, instrumentDigest, item, receipt: settlement.receipt, fallbackFingerprint: settlement.fallbackFingerprint, fallbackSettingsSha256: settlement.fallbackSettingsSha256 });
    this.stmt("INSERT INTO outbox (type,jobId,itemId,payload,createdAt,receiptId) VALUES (?,?,?,?,?,?)")
      .run(BROKER_RECEIPT_EVENT, jobId, item.id, JSON.stringify(payload), this.timestamp(), settlement.receipt.requestId);
    batch.events += 1;
    return true;
  }

  /**
   * Creates a job now, in its own transaction, so a submit returns only what is committed. `inputDigests[i]` is the
   * blob key of item i's input (sha256 of its JSON) when the caller computed it already.
   */
  createJob(job: WorkerJob, options: { inputDigests?: readonly string[] } = {}): void {
    this.applyNow((batch) => this.writeJob(job, batch, options.inputDigests ? { inputDigests: options.inputDigests } : {}));
  }

  /** Full job write (creation and rewrites); emits broker.job on a state change and the given terminal receipts. */
  putJob(job: WorkerJob, options: { receipts?: ReceiptSettlement[] } = {}): Promise<void> {
    const snapshot = structuredClone(job), receipts = options.receipts?.map((entry) => ({ ...entry, receipt: structuredClone(entry.receipt) }));
    return this.enqueue((batch) => this.writeJob(snapshot, batch, receipts ? { receipts } : {}), () => {
      for (const result of snapshot.results) if (SETTLED_ITEM_STATES.includes(result.state)) this.running.get(snapshot.jobId)?.delete(result.id);
    });
  }

  updateHeader(id: string, patch: Partial<Pick<WorkerJobHeader, "state" | "error" | "updatedAt" | "resumeAfter">>): WorkerJobHeader {
    const job = this.jobHeader(id); if (!job) throw new Error("Worker job is missing.");
    const previous = job.state;
    Object.assign(job, patch);
    if ("error" in patch && patch.error === undefined) delete job.error;
    if ("resumeAfter" in patch && patch.resumeAfter === undefined) delete job.resumeAfter;
    const snapshot = structuredClone(job);
    void this.enqueue((batch) => {
      this.saveHeader(snapshot, this.revision());
      if (previous !== snapshot.state) this.insertJobEvent(snapshot, batch);
    });
    return job;
  }

  /**
   * Items in flight when a job paused or was cancelled settle after its broker.job event,
   * so that event's counts still show them running. Once the job's execution has drained
   * (no running item left in memory), emit one more broker.job event with the same state
   * and the final counts, unless they did not change. Active jobs are left alone.
   */
  refreshJobCounts(jobId: string): Promise<void> {
    return this.enqueue((batch) => {
      if (this.running.has(jobId)) return;
      const row = this.stmt("SELECT payload FROM jobs WHERE id=?").get(jobId) as { payload: string } | undefined;
      if (!row) return;
      const job = JSON.parse(row.payload) as WorkerJobHeader;
      if (job.state === "queued" || job.state === "running") return;
      const last = this.stmt("SELECT payload FROM outbox WHERE jobId=? AND type=? ORDER BY seq DESC LIMIT 1").get(jobId, BROKER_JOB_EVENT) as { payload: string } | undefined;
      if (last) {
        const previous = JSON.parse(last.payload) as BrokerJobPayload;
        if (previous.state === job.state && canonicalJson(previous.counts) === canonicalJson(this.counts(jobId))) return;
      }
      this.insertJobEvent(job, batch);
    });
  }

  /** Running state stays in memory: no write when an item starts. */
  markRunning(jobId: string, item: ItemResult): void {
    let items = this.running.get(jobId); if (!items) { items = new Map(); this.running.set(jobId, items); }
    items.set(item.id, { ...item, state: "running" });
  }
  clearRunning(jobId: string, itemId?: string): void {
    if (itemId === undefined) { this.running.delete(jobId); return; }
    const items = this.running.get(jobId); items?.delete(itemId); if (items?.size === 0) this.running.delete(jobId);
  }
  runningCount(jobId: string): number { return this.running.get(jobId)?.size ?? 0; }
  runningIds(jobId: string): string[] { return [...this.running.get(jobId)?.keys() ?? []]; }

  /**
   * Settles one item: its result, its receipt and its outbox row in one write.
   * An item already settled in this job is never settled twice (compare-and-set),
   * so a duplicate completion produces neither a second result nor a second receipt.
   */
  settleItem(jobId: string, result: ItemResult, settlement?: ReceiptSettlement & { instrumentDigest: string | null }): Promise<void> {
    const item = structuredClone(result), receipt = settlement ? { ...settlement, receipt: structuredClone(settlement.receipt) } : undefined;
    return this.enqueue((batch) => {
      const revision = this.revision();
      const changed = this.stmt(`UPDATE job_items SET result=?,state=?,revision=? WHERE job_id=? AND item_id=? AND state NOT IN ${SETTLED_SQL}`).run(JSON.stringify(item), item.state, revision, jobId, item.id);
      if (Number(changed.changes) === 0) { this.stats.duplicateSettlements += 1; return; }
      batch.touched.add(jobId);
      if (!receipt) return;
      if (receipt.persist) this.writeReceiptRow(receipt.receipt);
      if (receipt.event) this.insertReceiptEvent(jobId, receipt.instrumentDigest, item, receipt, batch);
    }, () => this.clearRunning(jobId, item.id));
  }

  /** Non-terminal item update (legacy callers); never rewrites the job header payload. */
  updateItem(id: string, itemId: string, patch: Partial<Omit<ItemResult, "id">>): ItemResult {
    const item = this.item(id, itemId); if (!item || !this.jobHeader(id)) throw new Error("Worker result is missing.");
    Object.assign(item, patch);
    const snapshot = structuredClone(item);
    void this.enqueue((batch) => {
      this.stmt("UPDATE job_items SET result=?,state=?,revision=? WHERE job_id=? AND item_id=?").run(JSON.stringify(snapshot), snapshot.state, this.revision(), id, itemId);
      batch.touched.add(id);
    });
    return item;
  }

  /** Receipt rows are coalesced per request within a batch: the newest snapshot wins. */
  putReceipt(receipt: UsageReceipt): void {
    const json = JSON.stringify(receipt), pending = this.pendingReceipts.get(receipt.requestId);
    if (pending) { pending.json = json; pending.receipt = receipt; return; }
    const entry = { json, receipt };
    this.pendingReceipts.set(receipt.requestId, entry);
    void this.enqueue(() => this.writeReceiptRow(entry.receipt, entry.json));
  }

  // ---------------------------------------------------------------- reads

  jobHeader(id: string): WorkerJobHeader | null {
    this.flushPending();
    const row = this.stmt("SELECT payload FROM jobs WHERE id=?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as WorkerJobHeader : null;
  }
  jobHeaders(parent?: string, attempt?: string): WorkerJobHeader[] {
    this.flushPending();
    const rows = parent && attempt ? this.stmt("SELECT payload FROM jobs WHERE parent=? AND attempt=? ORDER BY rowid").all(parent, attempt)
      : parent ? this.stmt("SELECT payload FROM jobs WHERE parent=? ORDER BY rowid").all(parent) : this.stmt("SELECT payload FROM jobs ORDER BY rowid").all();
    return rows.map((r) => JSON.parse((r as { payload: string }).payload) as WorkerJobHeader);
  }
  item(id: string, itemId: string): ItemResult | null {
    this.flushPending();
    const running = this.running.get(id)?.get(itemId); if (running) return structuredClone(running);
    const row = this.stmt("SELECT result FROM job_items WHERE job_id=? AND item_id=?").get(id, itemId) as { result: string } | undefined;
    return row ? JSON.parse(row.result) as ItemResult : null;
  }
  private hydrate(job: WorkerJobHeader, overlay = true): WorkerJob {
    const rows = this.stmt("SELECT ji.item_id AS item_id, ji.input AS input, ji.result AS result, b.data AS blob FROM job_items ji LEFT JOIN item_inputs ii ON ii.job_id=ji.job_id AND ii.item_id=ji.item_id LEFT JOIN blobs b ON b.digest=ii.digest WHERE ji.job_id=? ORDER BY ji.ordinal").all(job.jobId) as { item_id: string; input: string | null; result: string; blob: string | null }[];
    const running = overlay ? this.running.get(job.jobId) : undefined;
    const request = job.kind === "bulk" ? { ...job.request, items: rows.map((r) => ({ id: r.item_id, input: JSON.parse(r.input ?? r.blob ?? "null") as BulkSubmit["items"][number]["input"] })) } as BulkSubmit : job.request as WorkerJob["request"];
    return { ...job, request, results: rows.map((r) => running?.get(r.item_id) ? structuredClone(running.get(r.item_id)!) : JSON.parse(r.result) as ItemResult) };
  }
  /** The job with its items; `overlay: false` returns committed item states without in-memory running ones. */
  job(id: string, options: { overlay?: boolean } = {}): WorkerJob | null { const job = this.jobHeader(id); return job ? this.hydrate(job, options.overlay ?? true) : null; }
  duplicate(parent: string, attempt: string, key: string): WorkerJob | null {
    this.flushPending();
    const row = this.stmt("SELECT id FROM jobs WHERE parent=? AND attempt=? AND request_key=?").get(parent, attempt, key) as { id: string } | undefined;
    return row ? this.job(row.id) : null;
  }
  jobs(parent?: string): WorkerJob[] { return this.jobHeaders(parent).map((job) => this.hydrate(job)); }
  /** Job counts by state from the state index (ops idle checks). */
  countJobsByState(): Record<JobState, number> {
    this.flushPending();
    const counts = Object.fromEntries(states.map((state) => [state, 0])) as Record<JobState, number>;
    for (const row of this.stmt("SELECT json_extract(payload,'$.state') AS state, count(*) AS count FROM jobs GROUP BY 1").all() as { state: string; count: number }[]) {
      if ((states as string[]).includes(row.state)) counts[row.state as JobState] = Number(row.count);
    }
    return counts;
  }
  progress(id: string): JobProgress {
    this.flushPending();
    const progress = { total: 0, ...Object.fromEntries(states.map((state) => [state, 0])) } as JobProgress;
    for (const row of this.stmt("SELECT state,count(*) AS count FROM job_items WHERE job_id=? GROUP BY state").all(id) as { state: JobState; count: number }[]) { progress[row.state] = Number(row.count); progress.total += Number(row.count); }
    for (const itemId of this.running.get(id)?.keys() ?? []) {
      const row = this.stmt("SELECT state FROM job_items WHERE job_id=? AND item_id=?").get(id, itemId) as { state: JobState } | undefined;
      if (row?.state === "queued") { progress.queued -= 1; progress.running += 1; }
    }
    return progress;
  }
  summaries(parent?: string, options: PageOptions = {}) {
    const { after, limit } = pageOptions(options);
    this.flushPending();
    const rows = (parent ? this.stmt("SELECT payload,revision FROM jobs WHERE parent=? AND revision>? ORDER BY revision LIMIT ?").all(parent, after, limit + 1)
      : this.stmt("SELECT payload,revision FROM jobs WHERE revision>? ORDER BY revision LIMIT ?").all(after, limit + 1)) as StoredRow[];
    const page = rows.slice(0, limit);
    return { jobs: page.map((r) => { const job = JSON.parse(r.payload) as WorkerJobHeader; return { job, revision: Number(r.revision), progress: this.progress(job.jobId) }; }), nextCursor: page.length ? Number(page.at(-1)!.revision) : after, hasMore: rows.length > limit };
  }
  summary(id: string) {
    this.flushPending();
    const row = this.stmt("SELECT payload,revision FROM jobs WHERE id=?").get(id) as StoredRow | undefined;
    return row ? { job: JSON.parse(row.payload) as WorkerJobHeader, revision: Number(row.revision), progress: this.progress(id) } : null;
  }
  resultPage(id: string, options: PageOptions = {}): ResultPage {
    const { after, limit } = pageOptions(options);
    this.flushPending();
    const rows = this.stmt("SELECT result,revision FROM job_items WHERE job_id=? AND revision>? ORDER BY revision LIMIT ?").all(id, after, limit + 1) as { result: string; revision: number }[];
    const page = rows.slice(0, limit);
    return { jobId: id, results: page.map((r) => ({ ...JSON.parse(r.result) as ItemResult, revision: Number(r.revision) })), nextCursor: page.length ? Number(page.at(-1)!.revision) : after, hasMore: rows.length > limit };
  }
  itemReceipt(jobId: string, itemId: string): UsageReceipt | null {
    this.flushPending();
    const row = this.stmt("SELECT payload FROM receipts WHERE job_id=? AND item_id=? ORDER BY rowid DESC LIMIT 1").get(jobId, itemId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as UsageReceipt : null;
  }
  jobReceipts(jobId: string): UsageReceipt[] {
    this.flushPending();
    const rows = this.stmt("SELECT payload FROM receipts WHERE job_id=? ORDER BY rowid").all(jobId) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as UsageReceipt);
  }
  receipts(parent?: string, attempt?: string): UsageReceipt[] {
    this.flushPending();
    const rows = parent && attempt ? this.stmt("SELECT payload FROM receipts WHERE parent=? AND attempt=? ORDER BY rowid").all(parent, attempt)
      : parent ? this.stmt("SELECT payload FROM receipts WHERE parent=? ORDER BY rowid").all(parent) : this.stmt("SELECT payload FROM receipts ORDER BY rowid").all();
    return rows.map((r) => JSON.parse((r as { payload: string }).payload) as UsageReceipt);
  }
  /** Storage era of a job (see P1_STORAGE_VERSION), or null when it is missing. */
  storageVersion(id: string): number | null {
    this.flushPending();
    const row = this.stmt("SELECT storage_version AS version FROM jobs WHERE id=?").get(id) as { version: number } | undefined;
    return row ? Number(row.version) : null;
  }

  // ---------------------------------------------------------------- recovery

  /**
   * Restart recovery. Bulk jobs written by P1 are requeued: their unsettled items
   * return to queued (side-effect-free inference may run again) and the job is
   * relaunched when `relaunch` says its authority survived the restart, otherwise
   * it waits for an explicit resume. Jobs from before P1 and agent jobs are
   * interrupted exactly as before. Returns child sessions to quiesce.
   */
  recover(options: { relaunch?: (job: WorkerJobHeader) => boolean } = {}): string[] {
    this.flushPending();
    const children: string[] = [], requeued: string[] = [], relaunch: string[] = [];
    const active = (this.indexes.state
      ? this.stmt("SELECT payload, storage_version AS version FROM jobs WHERE json_extract(payload,'$.state') IN ('queued','running') ORDER BY rowid").all()
      : this.stmt("SELECT payload, storage_version AS version FROM jobs ORDER BY rowid").all()) as { payload: string; version: number }[];
    for (const row of active) {
      const metadata = JSON.parse(row.payload) as WorkerJobHeader;
      if (!["queued", "running"].includes(metadata.state)) continue;
      if (metadata.childSessionName) children.push(metadata.childSessionName);
      if (metadata.kind === "bulk" && Number(row.version) >= P1_STORAGE_VERSION) {
        const resume = options.relaunch?.(metadata) === true;
        this.applyNow((batch) => {
          for (const item of this.stmt("SELECT item_id, result FROM job_items WHERE job_id=? AND state='running'").all(metadata.jobId) as { item_id: string; result: string }[]) {
            const result = JSON.parse(item.result) as ItemResult; result.state = "queued"; delete result.error;
            this.stmt("UPDATE job_items SET result=?,state='queued',revision=? WHERE job_id=? AND item_id=?").run(JSON.stringify(result), this.revision(), metadata.jobId, item.item_id);
          }
          const job: WorkerJobHeader = { ...metadata, state: resume ? "queued" : "interrupted", updatedAt: this.timestamp() };
          if (resume) delete job.error; else job.error = "Runner restarted; resume the job to dispatch its requeued items.";
          this.saveHeader(job, this.revision());
          if (job.state !== metadata.state) this.insertJobEvent(job, batch);
        });
        requeued.push(metadata.jobId); if (resume) relaunch.push(metadata.jobId);
        continue;
      }
      const job = this.hydrate(metadata);
      job.state = "interrupted"; job.error = "Runner restarted; dispatched work requires an explicit resume."; job.updatedAt = this.timestamp();
      for (const result of job.results) if (["queued", "running"].includes(result.state)) { result.state = "interrupted"; result.error = job.error; }
      this.applyNow((batch) => this.writeJob(job, batch, {}));
    }
    const running = (this.indexes.running
      ? this.stmt("SELECT payload FROM receipts WHERE json_extract(payload,'$.state')='running'").all()
      : this.stmt("SELECT payload FROM receipts").all()) as { payload: string }[];
    for (const row of running) {
      const receipt = JSON.parse(row.payload) as UsageReceipt;
      if (receipt.state !== "running") continue;
      receipt.state = "interrupted"; receipt.usage.quality = receipt.usage.input == null ? "unavailable" : "partial"; receipt.updatedAt = this.timestamp();
      this.applyNow(() => this.writeReceiptRow(receipt));
    }
    this.recovery = { requeued, relaunch };
    return children;
  }
  /** Jobs the last recover() requeued, and those it marked for relaunch. */
  get lastRecovery(): { requeued: string[]; relaunch: string[] } { return { requeued: [...this.recovery.requeued], relaunch: [...this.recovery.relaunch] }; }

  /**
   * An older daemon writes no outbox rows. When the revision counter moved past the
   * last revision the outbox reflects, emit the current state of every job and the
   * terminal receipt of every item it changed, so the feed stays complete across a
   * rollback and roll-forward.
   */
  private catchUp(): void {
    const meta = this.db.prepare("SELECT synced_revision AS synced FROM outbox_meta WHERE id=1").get() as { synced: number };
    const current = Number((this.db.prepare("SELECT value FROM change_sequence WHERE id=1").get() as { value: number }).value);
    if (current <= Number(meta.synced)) return;
    const synced = Number(meta.synced);
    this.applyNow((batch) => {
      for (const row of this.stmt("SELECT payload FROM jobs WHERE revision>? ORDER BY revision").all(synced) as { payload: string }[]) this.insertJobEvent(JSON.parse(row.payload) as WorkerJobHeader, batch);
      const items = this.stmt(`SELECT ji.job_id AS job_id, ji.result AS result, j.payload AS job FROM job_items ji JOIN jobs j ON j.id=ji.job_id WHERE ji.revision>? AND ji.state IN ${SETTLED_SQL} ORDER BY ji.revision`).all(synced) as { job_id: string; result: string; job: string }[];
      for (const row of items) {
        const item = JSON.parse(row.result) as ItemResult;
        const receiptRow = this.stmt("SELECT payload FROM receipts WHERE job_id=? AND item_id=? ORDER BY rowid DESC LIMIT 1").get(row.job_id, item.id) as { payload: string } | undefined;
        if (!receiptRow) continue;
        const receipt = JSON.parse(receiptRow.payload) as UsageReceipt;
        // Receipts of older daemons carry no provenance digests: derive what the row proves.
        this.insertReceiptEvent(row.job_id, instrumentDigestOf(JSON.parse(row.job) as WorkerJobHeader), item, {
          receipt, event: true, persist: false,
          fallbackFingerprint: serverFingerprint({ model: receipt.model }),
          fallbackSettingsSha256: settingsSha256(effectiveSettings({ model: receipt.model }))
        }, batch);
      }
    });
  }

  // ---------------------------------------------------------------- erasure

  /** Parents of jobs and receipts attributed to an owner (indexed; no full scans). */
  ownedParents(owner: string): string[] {
    this.flushPending();
    if (!this.indexes.owner) {
      return [...new Set([...this.jobHeaders().filter((j) => j.ownerKey === owner).map((j) => j.parentSessionName), ...this.receipts().filter((r) => r.ownerKey === owner).map((r) => r.parentSessionName)])];
    }
    const rows = this.stmt("SELECT parent FROM jobs WHERE json_extract(payload,'$.ownerKey')=? UNION SELECT parent FROM receipts WHERE json_extract(payload,'$.ownerKey')=?").all(owner, owner) as { parent: string }[];
    return [...new Set(rows.map((row) => row.parent))];
  }

  private jobsOfSession(name: string): string[] {
    const rows = this.indexes.child
      ? this.stmt("SELECT id FROM jobs WHERE parent=? UNION SELECT id FROM jobs WHERE json_extract(payload,'$.childSessionName')=?").all(name, name)
      : this.stmt("SELECT id FROM jobs WHERE parent=? OR json_extract(payload,'$.childSessionName')=?").all(name, name);
    return (rows as { id: string }[]).map((row) => row.id);
  }
  private hasUnacknowledgedEvents(jobId: string): boolean {
    return this.stmt("SELECT 1 FROM outbox WHERE jobId=? AND seq>? LIMIT 1").get(jobId, this.ackedSeq) !== undefined;
  }

  /**
   * Permanent session erasure. A job the feed has fully acknowledged goes at once with everything it holds. A job
   * with unacknowledged events loses its content at once (deferErasure); only its receipt rows and unacknowledged
   * events wait for the feed, since a receipt is never deleted before it reached Postgres.
   */
  purgeSession(name: string): void {
    this.applyNow(() => {
      const ids = this.jobsOfSession(name), deferred = new Set(ids.filter((id) => this.hasUnacknowledgedEvents(id)));
      for (const row of this.stmt("SELECT id, job_id FROM receipts WHERE parent=?").all(name) as { id: string; job_id: string | null }[]) {
        if (row.job_id && (deferred.has(row.job_id) || this.erasurePending(row.job_id))) continue;
        this.stmt("DELETE FROM receipts WHERE id=?").run(row.id);
      }
      for (const id of ids) {
        if (deferred.has(id)) this.deferErasure(id);
        else this.eraseJob(id);
      }
      this.countErasuresPending();
    });
    for (const id of [...this.running.keys()]) if (!this.jobExists(id)) this.running.delete(id);
  }
  private jobExists(id: string): boolean { return this.stmt("SELECT 1 FROM jobs WHERE id=?").get(id) !== undefined; }
  private erasurePending(id: string): boolean { return this.stmt("SELECT 1 FROM erasure_pending WHERE job_id=?").get(id) !== undefined; }

  private eraseJob(id: string): void {
    const digests = (this.stmt("SELECT DISTINCT digest FROM item_inputs WHERE job_id=?").all(id) as { digest: string }[]).map((row) => row.digest);
    this.stmt("DELETE FROM receipts WHERE job_id=?").run(id);
    this.stmt("DELETE FROM outbox WHERE jobId=? AND seq<=?").run(id, this.ackedSeq);
    this.stmt("DELETE FROM jobs WHERE id=?").run(id);
    for (const digest of digests) this.stmt("DELETE FROM blobs WHERE digest=? AND NOT EXISTS (SELECT 1 FROM item_inputs WHERE digest=?)").run(digest, digest);
    this.running.delete(id); this.headerTouches.delete(id);
  }

  /**
   * The erasure of a job whose events the feed has not acknowledged: its header, items, inputs, blobs and
   * acknowledged events go now, and its unacknowledged receipt events lose their inline output (outputDigest and
   * outputBytes stay). Its receipt rows (provenance, no content) and unacknowledged events stay until the
   * acknowledgement covers them; erasure_pending tracks the job by session and owner until then.
   */
  private deferErasure(id: string): void {
    const header = this.stmt("SELECT parent, json_extract(payload,'$.ownerKey') AS owner FROM jobs WHERE id=?").get(id) as { parent: string; owner: unknown } | undefined;
    if (!header) return;
    this.stmt("INSERT OR IGNORE INTO erasure_pending (job_id, session, owner_key, requested_at) VALUES (?,?,?,?)").run(id, header.parent, typeof header.owner === "string" ? header.owner : null, this.timestamp());
    for (const event of this.stmt("SELECT seq, payload FROM outbox WHERE jobId=? AND seq>? AND type=?").all(id, this.ackedSeq, BROKER_RECEIPT_EVENT) as { seq: number; payload: string }[]) {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      if (!("output" in payload)) continue;
      delete payload.output;
      this.stmt("UPDATE outbox SET payload=? WHERE seq=?").run(JSON.stringify(payload), event.seq);
    }
    const digests = (this.stmt("SELECT DISTINCT digest FROM item_inputs WHERE job_id=?").all(id) as { digest: string }[]).map((row) => row.digest);
    this.stmt("DELETE FROM outbox WHERE jobId=? AND seq<=?").run(id, this.ackedSeq);
    this.stmt("DELETE FROM jobs WHERE id=?").run(id);
    for (const digest of digests) this.stmt("DELETE FROM blobs WHERE digest=? AND NOT EXISTS (SELECT 1 FROM item_inputs WHERE digest=?)").run(digest, digest);
    this.running.delete(id); this.headerTouches.delete(id);
  }

  /** Completes the erasures whose events the feed has now acknowledged: their receipt rows and remaining events go. */
  private completeDeferredPurgesIn(): number {
    let erased = 0;
    for (const row of this.stmt("SELECT job_id FROM erasure_pending").all() as { job_id: string }[]) {
      if (this.hasUnacknowledgedEvents(row.job_id)) continue;
      if (this.jobExists(row.job_id)) this.eraseJob(row.job_id);
      this.stmt("DELETE FROM receipts WHERE job_id=?").run(row.job_id);
      this.stmt("DELETE FROM outbox WHERE jobId=? AND seq<=?").run(row.job_id, this.ackedSeq);
      this.stmt("DELETE FROM erasure_pending WHERE job_id=?").run(row.job_id);
      erased += 1;
    }
    this.countErasuresPending();
    return erased;
  }
  private countErasuresPending(): void { this.erasuresPending = Number((this.stmt("SELECT count(*) AS n FROM erasure_pending").get() as { n: number }).n); }

  /** Jobs whose erasure waits for the feed acknowledgement, optionally of one owner or session. */
  pendingErasures(filter: { owner?: string; session?: string } = {}): string[] {
    this.flushPending();
    const rows = filter.owner !== undefined ? this.stmt("SELECT job_id FROM erasure_pending WHERE owner_key=? ORDER BY job_id").all(filter.owner)
      : filter.session !== undefined ? this.stmt("SELECT job_id FROM erasure_pending WHERE session=? ORDER BY job_id").all(filter.session)
        : this.stmt("SELECT job_id FROM erasure_pending ORDER BY job_id").all();
    return (rows as { job_id: string }[]).map((row) => row.job_id);
  }
  /** How many jobs wait for the feed acknowledgement to complete their erasure (kept in memory, O(1)). */
  get pendingErasureCount(): number { return this.erasuresPending; }

  /** Blobs no item references any more (left by an older daemon's erasure). */
  private collectOrphanBlobs(): void {
    this.db.exec("DELETE FROM blobs WHERE NOT EXISTS (SELECT 1 FROM item_inputs WHERE item_inputs.digest=blobs.digest)");
  }

  // ---------------------------------------------------------------- feed

  get feedId(): string { return this.feed; }
  get acked(): number { return this.ackedSeq; }
  /** Highest seq ever written (never reused, also after pruning). */
  head(): number { this.flushPending(); return this.headSeq; }

  /** Makes every committed event durable against power loss before it leaves the daemon. */
  private syncDurable(): void {
    if (this.headSeq <= this.durableSeq) return;
    const target = this.headSeq;
    // A FULL commit fsyncs the WAL, and with it every earlier commit. It must change a
    // row: an unchanged one writes no WAL frame and syncs nothing.
    this.db.exec("PRAGMA synchronous=FULL");
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try { this.stmt("UPDATE outbox_meta SET durable_seq=? WHERE id=1").run(target); this.db.exec("COMMIT"); } catch (error) { this.rollback(); throw error; }
    } finally { this.db.exec("PRAGMA synchronous=NORMAL"); }
    this.durableSeq = target;
  }

  /** Events after a seq, in seq order. A cursor beyond the head comes from another outbox. */
  events(after: number, limit: number): FeedPage {
    if (!Number.isSafeInteger(after) || after < 0) throw new FeedCursorError("INVALID_EVENT_CURSOR", "after must be a non-negative integer seq.");
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer.");
    this.flushPending();
    if (after > this.headSeq) throw new FeedCursorError("INVALID_EVENT_CURSOR", "after is beyond the newest event; restart from 0.");
    this.syncDurable();
    const rows = this.stmt("SELECT seq, type, jobId AS job_id, itemId AS item_id, payload, createdAt AS created_at FROM outbox WHERE seq>? ORDER BY seq LIMIT ?").all(after, limit + 1) as { seq: number; type: BrokerEventType; job_id: string; item_id: string | null; payload: string; created_at: string }[];
    const page = rows.slice(0, limit).map((row) => ({
      seq: Number(row.seq), type: row.type, at: row.created_at, jobId: row.job_id,
      ...(row.item_id != null ? { itemId: row.item_id } : {}), payload: JSON.parse(row.payload) as BrokerEvent["payload"]
    }));
    return { feedId: this.feed, events: page, next: page.at(-1)?.seq ?? after, hasMore: rows.length > limit, head: this.headSeq, acked: this.ackedSeq };
  }

  /** Resolves once an event after `after` is committed, the wait expires, the signal aborts or the store closes. */
  waitForEvents(after: number, waitMs: number, signal?: AbortSignal): Promise<void> {
    this.flushPending();
    if (this.closed || this.headSeq > after || waitMs <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiter = { after, wake: () => finish() };
      const timer = setTimeout(() => finish(), waitMs); timer.unref?.();
      const finish = () => { clearTimeout(timer); this.waiters.delete(waiter); signal?.removeEventListener("abort", finish); resolve(); };
      signal?.addEventListener("abort", finish, { once: true });
      this.waiters.add(waiter);
    });
  }
  /** Ends every pending long poll now (daemon shutdown). */
  wakeAll(): void { for (const waiter of [...this.waiters]) waiter.wake(); }
  private wakeWaiters(): void { for (const waiter of [...this.waiters]) if (this.headSeq > waiter.after) waiter.wake(); }

  /**
   * Acknowledges every event up to `through`, durably; the acknowledgement never
   * moves backwards. Completes erasures that waited for these events.
   */
  ack(feedId: string, through: number): number {
    if (feedId !== this.feed) throw new FeedCursorError("FEED_REPLACED", "The outbox was replaced; restart the feed from 0.");
    this.flushPending();
    if (!Number.isSafeInteger(through) || through < 0 || through > this.headSeq) throw new FeedCursorError("INVALID_EVENT_CURSOR", "through must be a seq between 0 and the head.");
    if (through <= this.ackedSeq) return this.ackedSeq;
    this.db.exec("PRAGMA synchronous=FULL");
    try {
      this.applyNow(() => {
        this.stmt("UPDATE outbox_meta SET acked=?, acked_at=? WHERE id=1 AND acked<?").run(through, this.timestamp(), through);
        this.ackedSeq = through;
        this.completeDeferredPurgesIn();
      });
    } catch (error) {
      this.ackedSeq = Number((this.stmt("SELECT acked FROM outbox_meta WHERE id=1").get() as { acked: number }).acked);
      throw error;
    } finally { this.db.exec("PRAGMA synchronous=NORMAL"); }
    return this.ackedSeq;
  }

  /** Retention (opt-in): deletes acknowledged events older than the cutoff; unacknowledged ones are never pruned. */
  pruneAcknowledged(olderThan: Date): number {
    let removed = 0;
    this.applyNow(() => { removed = Number(this.stmt("DELETE FROM outbox WHERE seq<=? AND createdAt<?").run(this.ackedSeq, olderThan.toISOString()).changes); });
    return removed;
  }

  // ---------------------------------------------------------------- instruments

  /** Installs an instrument bundle under its opaque digest; idempotent for the same bundle. */
  putInstrument(digest: string, bundle: Record<string, unknown>, settingsSha256: string): InstrumentRecord {
    const canonical = canonicalJson(bundle);
    this.flushPending();
    const existing = this.stmt("SELECT bundle, settings_sha256, installed_at FROM instruments WHERE digest=?").get(digest) as { bundle: string; settings_sha256: string; installed_at: string } | undefined;
    if (existing) {
      if (existing.bundle !== canonical) throw new InstrumentConflictError();
      return { digest, bundle: JSON.parse(existing.bundle) as Record<string, unknown>, settingsSha256: existing.settings_sha256, installedAt: existing.installed_at };
    }
    const installedAt = this.timestamp();
    this.applyNow(() => { this.stmt("INSERT INTO instruments (digest, bundle, settings_sha256, installed_at) VALUES (?,?,?,?)").run(digest, canonical, settingsSha256, installedAt); });
    return { digest, bundle: JSON.parse(canonical) as Record<string, unknown>, settingsSha256, installedAt };
  }
  instrument(digest: string): InstrumentRecord | null {
    this.flushPending();
    const row = this.stmt("SELECT bundle, settings_sha256, installed_at FROM instruments WHERE digest=?").get(digest) as { bundle: string; settings_sha256: string; installed_at: string } | undefined;
    return row ? { digest, bundle: JSON.parse(row.bundle) as Record<string, unknown>, settingsSha256: row.settings_sha256, installedAt: row.installed_at } : null;
  }
  instruments(): InstrumentRecord[] {
    this.flushPending();
    return (this.stmt("SELECT digest, bundle, settings_sha256, installed_at FROM instruments ORDER BY installed_at, digest").all() as { digest: string; bundle: string; settings_sha256: string; installed_at: string }[])
      .map((row) => ({ digest: row.digest, bundle: JSON.parse(row.bundle) as Record<string, unknown>, settingsSha256: row.settings_sha256, installedAt: row.installed_at }));
  }

  // ---------------------------------------------------------------- archive

  /** Marks a job as referenced by a study; such jobs are never archived. */
  setStudyRef(jobId: string, studyRef: string | null): void {
    this.applyNow(() => { this.stmt("UPDATE jobs SET study_ref=? WHERE id=?").run(studyRef, jobId); });
  }

  /**
   * Opt-in verified archive: terminal jobs last updated before the cutoff move into a
   * new SQLite file under <root>/archive with their items (inputs materialized) and
   * receipts. Each job is copied, then counted and digested (sha256 over its canonical
   * rows) in both files, and deleted from the live store only when both agree. Only jobs
   * whose records provably reached Postgres qualify: written by P1 (every change and
   * receipt went to the outbox) with every event acknowledged. Jobs written before P1,
   * jobs of a run principal (runs are what studies reference), jobs with a study
   * reference and jobs with a pending erasure stay.
   */
  async archive(options: { before: Date; maxJobs?: number }): Promise<ArchiveReport> {
    this.flushPending();
    const report: ArchiveReport = { file: null, jobs: 0, items: 0, receipts: 0, skipped: { studyRef: 0, run: 0, historical: 0, unacknowledged: 0 }, manifest: null };
    const cutoff = options.before.toISOString();
    const candidates = (this.stmt(`SELECT id, study_ref AS study, storage_version AS version, json_extract(payload,'$.runId') AS run FROM jobs WHERE json_extract(payload,'$.state') IN (${TERMINAL_JOB_STATES.map((state) => `'${state}'`).join(",")}) AND json_extract(payload,'$.updatedAt')<? AND id NOT IN (SELECT job_id FROM erasure_pending) ORDER BY rowid`).all(cutoff) as { id: string; study: string | null; version: number; run: unknown }[]);
    const eligible: string[] = [];
    for (const row of candidates) {
      if (Number(row.version) < P1_STORAGE_VERSION) { report.skipped.historical += 1; continue; }
      if (row.study != null) { report.skipped.studyRef += 1; continue; }
      if (row.run != null) { report.skipped.run += 1; continue; }
      if (this.hasUnacknowledgedEvents(row.id)) { report.skipped.unacknowledged += 1; continue; }
      eligible.push(row.id);
      if (options.maxJobs !== undefined && eligible.length >= options.maxJobs) break;
    }
    if (eligible.length === 0) return report;
    const directory = join(this.root, "archive");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stamp = this.timestamp().replaceAll(":", "").replaceAll(".", "");
    const file = join(directory, `advanced-archive-${stamp}-${randomUUID().slice(0, 8)}.sqlite`);
    const { DatabaseSync } = await import(`node${":sqlite"}`);
    const archive = new DatabaseSync(file);
    await chmod(file, 0o600);
    archive.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE jobs (id TEXT PRIMARY KEY, parent TEXT NOT NULL, attempt TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, revision INTEGER NOT NULL, storage_version INTEGER NOT NULL);
      CREATE TABLE job_items (job_id TEXT NOT NULL, item_id TEXT NOT NULL, ordinal INTEGER NOT NULL, input TEXT, result TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(job_id,item_id));
      CREATE TABLE receipts (id TEXT PRIMARY KEY, parent TEXT NOT NULL, attempt TEXT NOT NULL, payload TEXT NOT NULL, job_id TEXT, item_id TEXT);
      CREATE TABLE manifest (job_id TEXT PRIMARY KEY, counts TEXT NOT NULL, sha256 TEXT NOT NULL, archived_at TEXT NOT NULL);`);
    const manifest: { jobId: string; counts: { jobs: number; items: number; receipts: number }; sha256: string }[] = [];
    try {
      for (const id of eligible) {
        this.flushPending();
        const live = this.archiveRows(id);
        archive.exec("BEGIN IMMEDIATE");
        try {
          for (const row of live.jobs) archive.prepare("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?)").run(row.id, row.parent, row.attempt, row.request_key, row.fingerprint, row.payload, row.revision, row.storage_version);
          const insertItem = archive.prepare("INSERT INTO job_items VALUES (?,?,?,?,?,?,?)");
          for (const row of live.items) insertItem.run(row.job_id, row.item_id, row.ordinal, row.input, row.result, row.state, row.revision);
          const insertReceipt = archive.prepare("INSERT INTO receipts VALUES (?,?,?,?,?,?)");
          for (const row of live.receipts) insertReceipt.run(row.id, row.parent, row.attempt, row.payload, row.job_id, row.item_id);
          archive.exec("COMMIT");
        } catch (error) { archive.exec("ROLLBACK"); throw error; }
        const copied = {
          jobs: archive.prepare("SELECT id, parent, attempt, request_key, fingerprint, payload, revision, storage_version FROM jobs WHERE id=?").all(id) as ArchiveJobRow[],
          items: archive.prepare("SELECT job_id, item_id, ordinal, input, result, state, revision FROM job_items WHERE job_id=? ORDER BY item_id").all(id) as ArchiveItemRow[],
          receipts: archive.prepare("SELECT id, parent, attempt, payload, job_id, item_id FROM receipts WHERE job_id=? ORDER BY id").all(id) as ArchiveReceiptRow[]
        };
        const liveDigest = archiveDigest(live), copyDigest = archiveDigest(copied);
        const counts = { jobs: live.jobs.length, items: live.items.length, receipts: live.receipts.length };
        if (liveDigest !== copyDigest || copied.jobs.length !== counts.jobs || copied.items.length !== counts.items || copied.receipts.length !== counts.receipts) {
          throw new Error(`Archive verification failed for job ${id}; the live rows were kept.`);
        }
        archive.prepare("INSERT INTO manifest VALUES (?,?,?,?)").run(id, JSON.stringify(counts), liveDigest, this.timestamp());
        // Erase only when nothing changed since the copy (the job is terminal, but stay strict).
        this.applyNow(() => {
          if (archiveDigest(this.archiveRows(id)) !== liveDigest) throw new Error(`Job ${id} changed during its archive; it stays live.`);
          this.eraseJob(id);
        });
        manifest.push({ jobId: id, counts, sha256: liveDigest });
        report.jobs += 1; report.items += counts.items; report.receipts += counts.receipts;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      archive.close();
    }
    const manifestFile = `${file}.manifest.json`;
    const total = createHash("sha256"); for (const entry of manifest) total.update(`${entry.jobId}:${entry.sha256}\n`);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(manifestFile, `${JSON.stringify({ version: 1, file, createdAt: this.timestamp(), before: cutoff, jobs: manifest, totals: { jobs: report.jobs, items: report.items, receipts: report.receipts }, sha256: total.digest("hex") }, null, 2)}\n`, { mode: 0o600 });
    report.file = file; report.manifest = manifestFile;
    return report;
  }

  private archiveRows(id: string): { jobs: ArchiveJobRow[]; items: ArchiveItemRow[]; receipts: ArchiveReceiptRow[] } {
    return {
      jobs: this.stmt("SELECT id, parent, attempt, request_key, fingerprint, payload, revision, storage_version FROM jobs WHERE id=?").all(id) as ArchiveJobRow[],
      items: this.stmt("SELECT ji.job_id AS job_id, ji.item_id AS item_id, ji.ordinal AS ordinal, COALESCE(ji.input, b.data) AS input, ji.result AS result, ji.state AS state, ji.revision AS revision FROM job_items ji LEFT JOIN item_inputs ii ON ii.job_id=ji.job_id AND ii.item_id=ji.item_id LEFT JOIN blobs b ON b.digest=ii.digest WHERE ji.job_id=? ORDER BY ji.item_id").all(id) as ArchiveItemRow[],
      receipts: this.stmt("SELECT id, parent, attempt, payload, job_id, item_id FROM receipts WHERE job_id=? ORDER BY id").all(id) as ArchiveReceiptRow[]
    };
  }

  // ---------------------------------------------------------------- diagnostics

  /** Connection settings, for diagnostics and tests. */
  pragmas(): { journalMode: string; synchronous: number; secureDelete: number } {
    const value = (pragma: string) => Object.values(this.db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown>)[0];
    return { journalMode: String(value("journal_mode")), synchronous: Number(value("synchronous")), secureDelete: Number(value("secure_delete")) };
  }
  pendingWrites(): number { return this.queue.length; }

  close(): void {
    if (this.closed) return;
    try { this.flushPending(); } finally {
      this.closed = true;
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
      this.wakeAll();
      this.db.close();
    }
  }
}

type ArchiveJobRow = { id: string; parent: string; attempt: string; request_key: string; fingerprint: string; payload: string; revision: number; storage_version: number };
type ArchiveItemRow = { job_id: string; item_id: string; ordinal: number; input: string | null; result: string; state: string; revision: number };
type ArchiveReceiptRow = { id: string; parent: string; attempt: string; payload: string; job_id: string | null; item_id: string | null };

/** sha256 over the canonical rows of one archived job, table by table in key order. */
function archiveDigest(rows: { jobs: ArchiveJobRow[]; items: ArchiveItemRow[]; receipts: ArchiveReceiptRow[] }): string {
  const hash = createHash("sha256");
  for (const [table, list] of [["jobs", rows.jobs], ["job_items", rows.items], ["receipts", rows.receipts]] as const) {
    for (const row of list) hash.update(`${table}\t${canonicalJson({ ...row })}\n`);
  }
  return hash.digest("hex");
}
