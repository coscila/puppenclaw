import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, rmdir, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";

import { ZodError } from "zod";

import { PuppenclawError } from "../shared/errors.js";
import type { ModelProviderConfig } from "../shared/types.js";
import { redactSensitiveText } from "../shared/utils.js";
import {
  canonicalGrants,
  jobInstrumentDigest,
  normalizeGrants,
  PRINCIPAL_PAUSE_REASONS,
  principalIdZod,
  principalPutZod,
  principalRefusalError,
  type PrincipalGrants,
  type PrincipalHooks,
  type PrincipalKind,
  type PrincipalPauseReason,
  type PrincipalRecord,
  type PrincipalState,
  type PrincipalUsage
} from "./principals-schema.js";
import { PrincipalStore, type PrincipalAuditEntry } from "./principals-store.js";
import { publicJob, type AdvancedRuntime } from "./runtime.js";
import { pageOptions } from "./store.js";
import {
  bulkSubmitZod,
  type AgentSubmit,
  type BulkSubmit,
  type RuntimeParticipant,
  type UsageReceipt,
  type WorkerConfig,
  type WorkerJob,
  type WorkerJobHeader
} from "./types.js";

/**
 * Run principals (plan P3): persisted grants, a private unix socket per
 * principal that is its only identity, and the admission gate the broker
 * runtime consults for every item of a principal job.
 *
 * Socket layout: `<data>/principals/` (0700) holds `principals.sqlite` and one
 * random directory per socket principal (0700) with `broker.sock` (0600). The
 * data directory lies inside the daemon state root, which every lab sandbox
 * hides; a sandbox reaches a principal only when its launcher binds that
 * principal's directory (see README, "Run principals").
 */

export const PRINCIPAL_PARENT_PREFIX = "principal:";
export const principalParent = (id: string): string => `${PRINCIPAL_PARENT_PREFIX}${id}`;
export const PRINCIPAL_SOCKET_FILE = "broker.sock";
/** sun_path holds 108 bytes including the terminating NUL. */
const MAX_SOCKET_PATH_BYTES = 107;
const PRINCIPAL_ASSIGNMENT = "Bulk work admitted under the grants of this principal.";
const REVOKED_MESSAGE = "Principal revoked; work it had not admitted was cancelled.";
const COUNTED_RECEIPTS = 4096;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const PLACEHOLDER_PROVIDER: ModelProviderConfig = { id: "principal", model: "none" };
const timestamp = (): string => new Date().toISOString();
const terminalJob = (state: string): boolean => ["completed", "failed", "cancelled", "interrupted"].includes(state);
const errorText = (error: unknown): string => redactSensitiveText(error instanceof Error ? error.message : String(error));

type SocketHandle = { server: Server; path: string; sockets: Set<Socket> };
type Entry = {
  record: PrincipalRecord;
  usage: PrincipalUsage;
  /** Admitted items still dispatching (slots held). */
  active: number;
  waiters: Set<() => void>;
  participant: RuntimeParticipant;
  socket: SocketHandle | undefined;
};

export type PrincipalView = {
  principalId: string;
  kind: PrincipalKind;
  runId: string | null;
  grants: PrincipalGrants;
  socketPath: string | null;
  createdAt: string;
  updatedAt: string;
};
export type PrincipalUsageView = PrincipalUsage & {
  activeItems: number;
  remaining: { items: number | null; inputTokens: number | null; outputTokens: number | null };
};
export type PrincipalDetail = PrincipalView & {
  state: PrincipalState;
  revokedAt: string | null;
  revision: number;
  usage: PrincipalUsageView;
  /** Granted providers this daemon has no configuration for (PUPPENCLAW_MODEL_PROVIDERS). */
  providersUnavailable: string[];
  audit: PrincipalAuditEntry[];
};
export type PrincipalSocketBinding = { principalId: string; directory: string; path: string };
export type PrincipalRegistryOptions = {
  dataDir: string;
  runtime: AdvancedRuntime;
  /** Providers a principal can be granted (modelProvidersFromEnvironment). */
  providers?: ReadonlyMap<string, ModelProviderConfig>;
  legacyAttemptAuthority?: boolean;
  now?: () => number;
  warn?: (message: string) => void;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** Changes only when the worker catalogue does, so grant and budget changes never break a pinned worker revision. */
function workersRevision(workers: WorkerConfig[]): number {
  return Number.parseInt(createHash("sha256").update(stable(workers)).digest("hex").slice(0, 12), 16);
}
function auditView(record: PrincipalRecord): Record<string, unknown> {
  return { grants: record.grants, socket: record.socket, revision: record.revision };
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid()))
    throw new PuppenclawError("PRINCIPAL_SOCKET_UNAVAILABLE", "A principal socket directory must be a private daemon-owned directory.");
  await chmod(path, 0o700);
}
async function removeSocketArtifacts(directory: string | null): Promise<void> {
  if (!directory) return;
  await unlink(join(directory, PRINCIPAL_SOCKET_FILE)).catch(() => undefined);
  await rmdir(directory).catch(() => undefined);
}
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk as Buffer);
    length += data.length;
    if (length > MAX_BODY_BYTES) throw new PuppenclawError("REQUEST_TOO_LARGE", "Principal request exceeds 64 MiB.");
    chunks.push(data);
  }
  return Buffer.concat(chunks).toString();
}
function queryPage(url: URL) {
  return pageOptions({ after: Number(url.searchParams.get("after") ?? 0), limit: Number(url.searchParams.get("limit") ?? 100) });
}
function socketStatus(error: unknown): [number, string] {
  if (error instanceof ZodError || error instanceof SyntaxError) return [400, "INVALID_REQUEST"];
  if (error instanceof RangeError) return [400, "INVALID_WORKER_CURSOR"];
  if (!(error instanceof PuppenclawError)) return [400, "INVALID_REQUEST"];
  switch (error.code) {
    case "PROVIDER_NOT_GRANTED":
    case "INSTRUMENT_NOT_GRANTED":
    case "INSTRUMENT_REQUIRED":
    case "PRINCIPAL_AGENT_UNSUPPORTED":
      return [403, error.code];
    case "INSTRUMENT_NOT_ALLOWED":
    case "INSTRUMENT_REQUEST_CONFLICT":
      return [400, error.code];
    case "WORKER_NOT_FOUND":
    case "WORKER_CONFIG_NOT_FOUND":
    case "UNKNOWN_PRINCIPAL_ROUTE":
      return [404, error.code];
    case "REQUEST_TOO_LARGE":
      return [413, error.code];
    default:
      return [409, error.code];
  }
}

export class PrincipalRegistry implements PrincipalHooks {
  readonly legacyAttemptAuthority: boolean;
  private readonly entries = new Map<string, Entry>();
  /** Receipts already charged; a settled receipt can be published twice. */
  private readonly counted = new Set<string>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly finishing = new Map<string, Promise<void>>();
  private closing = false;
  private storeClosed = false;

  private constructor(
    private readonly store: PrincipalStore,
    private readonly root: string,
    private readonly runtime: AdvancedRuntime,
    private readonly providers: ReadonlyMap<string, ModelProviderConfig>,
    legacyAttemptAuthority: boolean,
    private readonly now: () => number,
    private readonly warn: (message: string) => void
  ) {
    this.legacyAttemptAuthority = legacyAttemptAuthority;
  }

  /** Loads every principal, reattaches the live ones to the runtime and reopens their sockets at the same paths. */
  static async open(options: PrincipalRegistryOptions): Promise<PrincipalRegistry> {
    const root = join(options.dataDir, "principals");
    await privateDirectory(root);
    const store = await PrincipalStore.open(root);
    const registry = new PrincipalRegistry(store, root, options.runtime, options.providers ?? new Map(), options.legacyAttemptAuthority ?? true,
      options.now ?? Date.now, options.warn ?? (() => undefined));
    options.runtime.usePrincipals(registry);
    for (const record of store.all()) {
      if (record.revokedAt !== null) {
        // A revocation interrupted by a restart: nothing of it may stay open or resumable.
        await removeSocketArtifacts(record.socketDir);
        for (const job of options.runtime.store.jobHeaders(principalParent(record.id))) if (!terminalJob(job.state)) await options.runtime.cancel(job.jobId, REVOKED_MESSAGE);
        continue;
      }
      const entry = registry.attach(record);
      if (record.socket) await registry.listen(entry).catch((error: unknown) => registry.warn(`puppenclaw: principal ${record.id} socket did not reopen: ${errorText(error)}`));
    }
    return registry;
  }

  // --- pcp/2 routes -------------------------------------------------------

  /** PUT /v2/principals/{id}: the same body returns the same result; changed grants are applied live and audited. */
  async put(id: string, body: unknown): Promise<PrincipalView> {
    principalIdZod.parse(id);
    const parsed = principalPutZod.parse(body);
    return this.serialize(id, async () => {
      if (this.closing) throw principalRefusalError(PRINCIPAL_PAUSE_REASONS.shutdown);
      const existing = this.store.get(id);
      if (existing?.revokedAt) throw new PuppenclawError("PRINCIPAL_REVOKED", "This principal was revoked; a new principal needs a new id.");
      if (existing && (existing.kind !== parsed.kind || existing.runId !== parsed.runId || existing.ownerKey !== parsed.ownerKey))
        throw new PuppenclawError("PRINCIPAL_CONFLICT", "A principal's kind, runId and ownerKey cannot change.");
      const grants = normalizeGrants(parsed.grants);
      let entry = this.entries.get(id);
      if (existing && entry && canonicalGrants(existing.grants) === canonicalGrants(grants) && existing.socket === parsed.socket) {
        if (parsed.socket && !entry.socket) await this.listen(entry);
        return this.view(existing);
      }
      const now = timestamp();
      const socketDir = parsed.socket ? existing?.socketDir ?? await this.newSocketDirectory() : null;
      const record: PrincipalRecord = {
        id, kind: parsed.kind, runId: parsed.runId, ownerKey: parsed.ownerKey, grants, socket: parsed.socket, socketDir,
        revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now, revokedAt: null
      };
      const audit = { action: existing ? "updated" as const : "created" as const, before: existing ? auditView(existing) : null, after: auditView(record) };
      if (!entry) {
        // Attach first: a participant name conflict refuses the principal before anything is stored.
        entry = this.attach(record);
        try { this.store.save(record, audit); }
        catch (error) {
          entry.participant.admissionOpen = false;
          this.entries.delete(id);
          throw error;
        }
      } else {
        this.store.save(record, audit);
        entry.record = record;
        this.configure(entry);
        this.wakeAll(entry);
      }
      if (!parsed.socket && entry.socket) await this.closeSocket(entry);
      if (!parsed.socket && existing?.socketDir) await removeSocketArtifacts(existing.socketDir);
      if (parsed.socket && !entry.socket) await this.listen(entry);
      return this.view(record);
    });
  }

  /** GET /v2/principals/{id}: the record, its state and its usage against the budgets. */
  detail(id: string): PrincipalDetail | null {
    const entry = this.entries.get(id);
    const record = entry?.record ?? this.store.get(id);
    if (!record) return null;
    return {
      ...this.view(record),
      state: this.state(record),
      revokedAt: record.revokedAt,
      revision: record.revision,
      usage: this.usageView(record, entry?.usage ?? this.store.usage(id), entry?.active ?? 0),
      providersUnavailable: record.grants.providers.filter((provider) => !this.providers.has(provider)),
      audit: this.store.audit(id)
    };
  }

  /**
   * DELETE /v2/principals/{id}[?cancel=1]: admission closes before this returns
   * (the socket is gone and no further item is admitted); items already
   * dispatching finish, or abort with `cancel`, and work the principal never
   * admitted ends cancelled. Revocation is final.
   */
  async revoke(id: string, options: { cancel?: boolean } = {}): Promise<{ principalId: string; revokedAt: string }> {
    principalIdZod.parse(id);
    return this.serialize(id, async () => {
      const entry = this.entries.get(id);
      const record = entry?.record ?? this.store.get(id);
      if (!record) throw new PuppenclawError("PRINCIPAL_NOT_FOUND", "Unknown principal.");
      if (record.revokedAt !== null) return { principalId: id, revokedAt: record.revokedAt };
      const revokedAt = timestamp();
      this.store.revoke(id, revokedAt, auditView(record));
      if (!entry) return { principalId: id, revokedAt };
      entry.record = { ...record, revokedAt, updatedAt: revokedAt };
      entry.participant.admissionOpen = false;
      this.wakeAll(entry);
      await this.closeSocket(entry);
      await removeSocketArtifacts(record.socketDir);
      const finishing = this.finishJobs(id, options.cancel === true);
      this.finishing.set(id, finishing);
      void finishing.finally(() => { if (this.finishing.get(id) === finishing) this.finishing.delete(id); });
      return { principalId: id, revokedAt };
    });
  }

  /** Account erasure: revoke (and cancel) every principal of an owner before its jobs are purged. */
  async revokeOwner(ownerKey: string): Promise<void> {
    const ids = this.store.idsByOwner(ownerKey);
    for (const id of ids) await this.revoke(id, { cancel: true });
    await Promise.allSettled(ids.map((id) => this.finishing.get(id)));
  }

  /** The socket a compute launcher may bind for this principal, while it is live. */
  socketBinding(id: string): PrincipalSocketBinding | null {
    const entry = this.entries.get(id);
    if (!entry?.socket || entry.record.revokedAt !== null || !entry.record.socketDir) return null;
    return { principalId: id, directory: entry.record.socketDir, path: entry.socket.path };
  }

  // --- broker runtime hooks ----------------------------------------------

  admitJob(participant: RuntimeParticipant, kind: "agent" | "bulk", request: AgentSubmit | BulkSubmit, config: WorkerConfig): void {
    const entry = this.entryFor(participant);
    if (kind !== "bulk") throw new PuppenclawError("PRINCIPAL_AGENT_UNSUPPORTED", "Principal sockets carry bulk authority only.");
    const lifecycle = this.lifecycleRefusal(entry);
    if (lifecycle) throw principalRefusalError(lifecycle);
    const grants = entry.record.grants;
    if (!grants.providers.includes(config.modelProvider.id)) throw new PuppenclawError("PROVIDER_NOT_GRANTED", "This principal is not granted that provider.");
    const digest = jobInstrumentDigest({ request });
    if (digest !== undefined && !grants.instruments.includes(digest)) throw new PuppenclawError("INSTRUMENT_NOT_GRANTED", "This principal is not granted that instrument.");
    if (digest === undefined && grants.instruments.length > 0) throw new PuppenclawError("INSTRUMENT_REQUIRED", "This principal may submit only work under one of its granted instruments.");
  }

  refusal(participant: RuntimeParticipant, job: Pick<WorkerJobHeader, "config" | "request">): PrincipalPauseReason | undefined {
    const entry = participant.principalId === undefined ? undefined : this.entries.get(participant.principalId);
    return entry ? this.refusalFor(entry, job) : PRINCIPAL_PAUSE_REASONS.revoked;
  }

  async admitItem(participant: RuntimeParticipant, signal: AbortSignal, jobOfItem?: Pick<WorkerJobHeader, "config" | "request">): Promise<() => void> {
    const entry = this.entryFor(participant);
    const job = jobOfItem ?? (participant.jobId !== undefined ? this.runtime.store.jobHeader(participant.jobId) : null);
    for (;;) {
      signal.throwIfAborted();
      const refusal = this.refusalFor(entry, job);
      if (refusal) {
        // A refused waiter takes no slot: pass the wake-up on, so a refusal no event announced (expiry) reaches every waiter.
        entry.waiters.values().next().value?.();
        throw principalRefusalError(refusal);
      }
      if (entry.active < entry.record.grants.maxConcurrency) {
        entry.active += 1;
        entry.usage.items += 1;
        this.store.addUsage(entry.record.id, 1, 0, 0);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          entry.active -= 1;
          entry.waiters.values().next().value?.();
        };
      }
      await this.waitForSlot(entry, signal);
    }
  }

  /** Charges a settled principal receipt to the principal's token budget (once per request). */
  observeReceipt(receipt: UsageReceipt): void {
    if (receipt.state === "running" || !receipt.parentSessionName.startsWith(PRINCIPAL_PARENT_PREFIX)) return;
    const entry = this.entries.get(receipt.attemptId);
    if (!entry || entry.participant.parentSessionName !== receipt.parentSessionName || this.counted.has(receipt.requestId)) return;
    this.counted.add(receipt.requestId);
    if (this.counted.size > COUNTED_RECEIPTS) this.counted.delete(this.counted.values().next().value!);
    const input = Math.max(0, receipt.usage.input ?? 0), output = Math.max(0, receipt.usage.output ?? 0);
    if (input === 0 && output === 0) return;
    entry.usage.inputTokens += input;
    entry.usage.outputTokens += output;
    if (!this.storeClosed) {
      try { this.store.addUsage(entry.record.id, 0, input, output); }
      catch (error) { this.warn(`puppenclaw: principal usage was not persisted: ${errorText(error)}`); }
    }
    // Waiting items must see an exhausted budget now, not when a slot frees.
    if (this.refusalFor(entry, null)) this.wakeAll(entry);
  }

  // --- lifecycle ----------------------------------------------------------

  /**
   * Daemon shutdown, before the broker runtime closes: new items are refused
   * with `daemon_shutdown`, so principal jobs pause (resumable after the
   * restart) instead of ending. Socket directories stay, so bound sandboxes see
   * the reopened socket after the restart.
   */
  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const entry of this.entries.values()) this.wakeAll(entry);
    await Promise.all([...this.entries.values()].map((entry) => this.closeSocket(entry)));
  }

  /** After the broker runtime has closed. */
  async close(): Promise<void> {
    await this.shutdown();
    await Promise.allSettled([...this.finishing.values()]);
    if (!this.storeClosed) {
      this.storeClosed = true;
      this.store.close();
    }
  }

  // --- internals ----------------------------------------------------------

  private attach(record: PrincipalRecord): Entry {
    const name = principalParent(record.id);
    const participant: RuntimeParticipant = {
      sessionName: name, parentSessionName: name, attemptId: record.id, directory: "", provider: PLACEHOLDER_PROVIDER,
      ownerKey: record.ownerKey, permissionMode: "approve-all", interactionMode: "execute", config: { version: 1, revision: 0, workers: [] },
      principalId: record.id, ...(record.runId !== null ? { runId: record.runId } : {}), admissionOpen: record.revokedAt === null
    };
    const entry: Entry = { record, usage: this.store.usage(record.id), active: 0, waiters: new Set(), participant, socket: undefined };
    this.configure(entry);
    this.runtime.attachPrincipal(participant);
    this.entries.set(record.id, entry);
    return entry;
  }

  /** One bulk worker per granted provider this daemon is configured for. */
  private configure(entry: Entry): void {
    const workers: WorkerConfig[] = entry.record.grants.providers.flatMap((id) => {
      const provider = this.providers.get(id);
      return provider ? [{ id, assignment: PRINCIPAL_ASSIGNMENT, agent: provider.kind === "claude-code" ? "claude" as const : "codex" as const, modelProvider: provider }] : [];
    });
    entry.participant.config = { version: 1, revision: workersRevision(workers), workers };
    entry.participant.provider = workers[0]?.modelProvider ?? PLACEHOLDER_PROVIDER;
  }

  private entryFor(participant: RuntimeParticipant): Entry {
    const entry = participant.principalId === undefined ? undefined : this.entries.get(participant.principalId);
    if (!entry) throw principalRefusalError(PRINCIPAL_PAUSE_REASONS.revoked);
    return entry;
  }

  private state(record: PrincipalRecord): PrincipalState {
    if (record.revokedAt !== null) return "revoked";
    return record.grants.expiresAt !== null && Date.parse(record.grants.expiresAt) <= this.now() ? "expired" : "active";
  }

  private lifecycleRefusal(entry: Entry): PrincipalPauseReason | undefined {
    if (this.closing) return PRINCIPAL_PAUSE_REASONS.shutdown;
    const state = this.state(entry.record);
    return state === "revoked" ? PRINCIPAL_PAUSE_REASONS.revoked : state === "expired" ? PRINCIPAL_PAUSE_REASONS.expired : undefined;
  }

  private refusalFor(entry: Entry, job: Pick<WorkerJobHeader, "config" | "request"> | null): PrincipalPauseReason | undefined {
    const lifecycle = this.lifecycleRefusal(entry);
    if (lifecycle) return lifecycle;
    const grants = entry.record.grants;
    if (job) {
      if (!grants.providers.includes(job.config.modelProvider.id)) return PRINCIPAL_PAUSE_REASONS.grant;
      const digest = jobInstrumentDigest(job);
      if (digest !== undefined ? !grants.instruments.includes(digest) : grants.instruments.length > 0) return PRINCIPAL_PAUSE_REASONS.grant;
    }
    const { usage } = entry;
    if (grants.maxItems !== null && usage.items >= grants.maxItems) return PRINCIPAL_PAUSE_REASONS.budget;
    if (grants.tokenBudget?.input != null && usage.inputTokens >= grants.tokenBudget.input) return PRINCIPAL_PAUSE_REASONS.budget;
    if (grants.tokenBudget?.output != null && usage.outputTokens >= grants.tokenBudget.output) return PRINCIPAL_PAUSE_REASONS.budget;
    return undefined;
  }

  private waitForSlot(entry: Entry, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener("abort", aborted);
        entry.waiters.delete(wake);
        resolve();
      };
      const aborted = () => {
        entry.waiters.delete(wake);
        reject(new Error("Bulk dispatch cancelled while waiting for a principal slot."));
      };
      entry.waiters.add(wake);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  /** Every waiter re-checks admission: a grant change, an exhausted budget, a revocation or shutdown. A freed slot wakes one. */
  private wakeAll(entry: Entry): void {
    for (const wake of [...entry.waiters]) wake();
  }

  private usageView(record: PrincipalRecord, usage: PrincipalUsage, active: number): PrincipalUsageView {
    const grants = record.grants, left = (limit: number | null | undefined, used: number) => limit == null ? null : Math.max(0, limit - used);
    return {
      items: usage.items, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, activeItems: active,
      remaining: { items: left(grants.maxItems, usage.items), inputTokens: left(grants.tokenBudget?.input, usage.inputTokens), outputTokens: left(grants.tokenBudget?.output, usage.outputTokens) }
    };
  }

  private view(record: PrincipalRecord): PrincipalView {
    return {
      principalId: record.id, kind: record.kind, runId: record.runId, grants: record.grants,
      socketPath: record.socket && record.socketDir ? join(record.socketDir, PRINCIPAL_SOCKET_FILE) : null,
      createdAt: record.createdAt, updatedAt: record.updatedAt
    };
  }

  /** In-flight items finish first (or abort with cancel); everything else of the principal ends cancelled. */
  private async finishJobs(id: string, cancel: boolean): Promise<void> {
    const open = this.runtime.store.jobHeaders(principalParent(id)).filter((job) => !terminalJob(job.state));
    await Promise.all(open.map(async (job) => {
      if (!cancel) await this.runtime.settled(job.jobId);
      await this.runtime.cancel(job.jobId, REVOKED_MESSAGE);
    })).catch((error: unknown) => this.warn(`puppenclaw: revoked principal ${id} jobs did not settle: ${errorText(error)}`));
  }

  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.mutations.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
    const tail = result.catch(() => undefined);
    this.mutations.set(id, tail);
    void tail.then(() => { if (this.mutations.get(id) === tail) this.mutations.delete(id); });
    return result;
  }

  private async newSocketDirectory(): Promise<string> {
    if (Buffer.byteLength(join(this.root, "0".repeat(16), PRINCIPAL_SOCKET_FILE)) > MAX_SOCKET_PATH_BYTES)
      throw new PuppenclawError("PRINCIPAL_SOCKET_UNAVAILABLE", "The daemon data directory path is too long for a unix socket path.");
    for (;;) {
      const directory = join(this.root, randomBytes(8).toString("hex"));
      try {
        await mkdir(directory, { mode: 0o700 });
        return directory;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  private async listen(entry: Entry): Promise<void> {
    const directory = entry.record.socketDir;
    if (!directory || entry.socket) return;
    const path = join(directory, PRINCIPAL_SOCKET_FILE);
    if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) throw new PuppenclawError("PRINCIPAL_SOCKET_UNAVAILABLE", "The principal socket path is too long for a unix socket.");
    // The directory survives restarts so a sandbox that bound it sees the new socket; only the socket file is replaced.
    await privateDirectory(directory);
    await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    const sockets = new Set<Socket>();
    const server = createServer((req, res) => {
      req.on("error", () => res.destroy());
      res.on("error", () => res.destroy());
      void this.handle(entry, req, res);
    });
    // A principal socket is no egress proxy and no tunnel.
    server.on("connect", (_req, socket) => socket.destroy());
    server.on("upgrade", (_req, socket) => socket.destroy());
    server.on("clientError", (_error, socket) => socket.destroy());
    server.on("connection", (socket: Socket) => {
      socket.on("error", () => socket.destroy());
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => { server.removeListener("error", reject); resolve(); });
    });
    await chmod(path, 0o600);
    entry.socket = { server, path, sockets };
  }

  private async closeSocket(entry: Entry): Promise<void> {
    const handle = entry.socket;
    if (!handle) return;
    entry.socket = undefined;
    for (const socket of handle.sockets) socket.destroy();
    handle.server.closeAllConnections();
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
    await unlink(handle.path).catch(() => undefined);
  }

  /** The in-sandbox API, served to exactly one principal: identity is the socket, never a header, field or variable. */
  private async handle(entry: Entry, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    try {
      if (!(req.url ?? "").startsWith("/")) throw new PuppenclawError("UNKNOWN_PRINCIPAL_ROUTE", "A principal socket serves only its worker routes.");
      if (entry.record.revokedAt !== null) throw principalRefusalError(PRINCIPAL_PAUSE_REASONS.revoked);
      const url = new URL(req.url!, "http://principal"), path = url.pathname, summary = url.searchParams.get("view") === "summary";
      const parent = entry.participant.parentSessionName;
      if (req.method === "GET" && (path === "/configs" || path === "/configs/list")) return reply(200, this.catalog(entry));
      if (req.method === "GET" && path === "/jobs") return reply(200, summary ? this.runtime.jobSummaries(parent, queryPage(url)) : { jobs: this.runtime.jobs(parent) });
      if (req.method === "POST" && path === "/agent/submit") throw new PuppenclawError("PRINCIPAL_AGENT_UNSUPPORTED", "Principal sockets carry bulk authority only.");
      if (req.method === "POST" && path === "/bulk/submit") {
        const raw: unknown = JSON.parse(await readBody(req));
        this.preflight(entry, raw);
        return reply(200, await this.runtime.submit(entry.participant, "bulk", bulkSubmitZod.parse(raw), undefined, summary));
      }
      const route = /^\/jobs\/([a-f0-9-]+)(?:\/(cancel|resume|results))?$/u.exec(path);
      if (route) {
        const jobId = route[1]!;
        if (req.method === "GET" && route[2] === "results") return reply(200, this.runtime.jobResults(parent, jobId, queryPage(url)));
        const job = this.runtime.store.job(jobId);
        if (!job || job.parentSessionName !== parent) throw new PuppenclawError("WORKER_NOT_FOUND", "Worker job is not owned by this principal.");
        if (req.method === "GET" && !route[2]) return reply(200, summary ? this.runtime.jobSummary(jobId) : publicJob(job));
        if (req.method === "POST" && route[2] === "cancel") {
          await this.runtime.cancel(jobId);
          return reply(200, publicJob(this.runtime.store.job(jobId)!));
        }
        if (req.method === "POST" && route[2] === "resume") {
          this.assertResumable(entry, job);
          return reply(200, await this.runtime.resume(entry.participant, job));
        }
      }
      throw new PuppenclawError("UNKNOWN_PRINCIPAL_ROUTE", "A principal socket serves only its worker routes.");
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const [status, code] = socketStatus(error);
      reply(status, { error: errorText(error), code });
    }
  }

  /** Explicit refusals for a provider or instrument outside the grants, before the request is even parsed. */
  private preflight(entry: Entry, raw: unknown): void {
    const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const grants = entry.record.grants;
    if (typeof body.configId === "string" && this.providers.has(body.configId) && !grants.providers.includes(body.configId))
      throw new PuppenclawError("PROVIDER_NOT_GRANTED", "This principal is not granted that provider.");
    if (typeof body.instrumentDigest === "string" && !grants.instruments.includes(body.instrumentDigest))
      throw new PuppenclawError("INSTRUMENT_NOT_GRANTED", "This principal is not granted that instrument.");
  }

  /** A paused job resumes only once its principal may admit items again (e.g. after a PUT raised the budget). */
  private assertResumable(entry: Entry, job: WorkerJob): void {
    const refusal = this.refusalFor(entry, job);
    if (refusal) throw principalRefusalError(refusal);
  }

  private catalog(entry: Entry): Record<string, unknown> {
    const { record, participant } = entry, grants = record.grants, state = this.state(record);
    const concurrency = this.runtime.bulkConcurrency;
    return {
      version: 1,
      revision: participant.config.revision,
      capacity: {
        scope: "provider",
        providers: participant.config.workers.map((worker) => {
          const id = worker.modelProvider.id, group = concurrency.group(id);
          return { providerId: id, ...(group ? { capacityGroup: group } : {}), ...concurrency.snapshot(id) };
        })
      },
      authorization: {
        principalId: record.id, kind: record.kind, runId: record.runId, attemptId: record.id, state,
        publicLiteratureAllowed: record.kind === "run" && state === "active", instruments: grants.instruments
      },
      principal: { id: record.id, kind: record.kind, runId: record.runId, state, grants, revision: record.revision, usage: this.usageView(record, entry.usage, entry.active) },
      // Instrument mode, like the turn socket, but only the installed instruments this principal is granted.
      instrumentMode: 1,
      instruments: this.runtime.instruments().filter((installed) => grants.instruments.includes(installed.digest))
        .map((installed) => ({ digest: installed.digest, instrumentId: installed.bundle.instrumentId, version: installed.bundle.version, itemsPerCall: installed.bundle.itemsPerCall })),
      workers: participant.config.workers.map((worker) => ({
        id: worker.id, assignment: worker.assignment, providerId: worker.modelProvider.id, model: worker.modelProvider.model,
        modelProvider: { id: worker.modelProvider.id, model: worker.modelProvider.model, kind: worker.modelProvider.kind, label: worker.modelProvider.label, reasoningProfile: worker.modelProvider.reasoningProfile },
        agent: worker.agent,
        bulkConcurrencyLimit: Math.min(concurrency.limit(worker.modelProvider.id), grants.maxConcurrency),
        bulkAvailable: worker.modelProvider.kind === "codex-openai-compatible" && Boolean(worker.modelProvider.baseUrl && worker.modelProvider.authTokenEnv)
      }))
    };
  }
}
