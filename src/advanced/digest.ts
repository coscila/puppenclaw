import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

/**
 * Submission digests (job fingerprint, item digests, input blob digests). A census-sized bulk submission (a hundred
 * calls, about 13 MB) took about 70 ms of these on the event loop; SubmissionDigester computes them on a worker thread
 * instead, where posting the request costs a structured clone of a few milliseconds. The values are exactly the ones
 * computed inline (submissionDigests), so stored fingerprints, item digests and blob keys do not change.
 */

/**
 * The broker's canonical JSON for request digests: object keys sorted with localeCompare, no whitespace. Job
 * fingerprints made with it are stored and compared on every replayed submission, so it must never change. It uses
 * nothing but JSON, Object and Array: the digest worker runs this very function from its source text.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** sha256 of a string as is, of anything else as its stableJson. */
export function stableHash(input: unknown): string {
  return createHash("sha256").update(typeof input === "string" ? input : stableJson(input)).digest("hex");
}

/**
 * fingerprint: stableHash of {kind, config, request} (the job's idempotency fingerprint); items[i].digest: stableHash
 * of item i's input (its promptSha256 and inputSha256 before dispatch); items[i].blob: sha256 of its input's
 * JSON.stringify, the key of its stored input blob.
 */
export type SubmissionDigests = { fingerprint: string; items: { digest: string; blob: string }[] };
/** A submission as its digests see it: its items, and whatever else it carries (the fingerprint covers all of it). */
type DigestRequest = { readonly items: readonly { readonly input: unknown }[]; readonly [key: string]: unknown };

/** The digests of a submission, computed here and now. */
export function submissionDigests(kind: string, config: unknown, request: DigestRequest): SubmissionDigests {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    fingerprint: stableHash({ kind, config, request }),
    items: request.items.map((item) => ({ digest: stableHash(item.input), blob: sha(JSON.stringify(item.input) ?? "null") }))
  };
}

const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { createHash } = require("node:crypto");
const stableJson = ${stableJson.toString()};
const sha = (text) => createHash("sha256").update(text).digest("hex");
parentPort.on("message", (message) => {
  try {
    const { id, kind, config, request } = message;
    const fingerprint = sha(stableJson({ kind, config, request }));
    const items = request.items.map((item) => ({ digest: sha(typeof item.input === "string" ? item.input : stableJson(item.input)), blob: sha(JSON.stringify(item.input) ?? "null") }));
    parentPort.postMessage({ id, fingerprint, items });
  } catch (error) {
    parentPort.postMessage({ id: message && message.id, error: String((error && error.message) || error) });
  }
});
`;

/**
 * PUPPENCLAW_SUBMISSION_DIGESTS: `worker` (default) digests bulk submissions on the digest worker; `inline` digests
 * them on the event loop, as before. Either gives the same values. Any other value fails startup.
 */
export function submissionDigestsInlineFromEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PUPPENCLAW_SUBMISSION_DIGESTS?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "worker") return false;
  if (raw === "inline") return true;
  throw new Error("PUPPENCLAW_SUBMISSION_DIGESTS must be worker or inline.");
}

/** A worker that fails this often stays off: submissions are then digested inline, as before. */
const MAX_WORKER_FAILURES = 3;
type Pending = { resolve: (value: SubmissionDigests) => void; fallback: () => void };

/**
 * Digests bulk submissions on one lazily started worker thread (unreferenced, so it never keeps a process alive).
 * Any worker failure (it cannot start, throws, exits or answers malformed) digests the affected submissions inline, so
 * a submission never fails because of the worker.
 */
export class SubmissionDigester {
  private worker: Worker | undefined;
  private failures = 0;
  private next = 0;
  private closed = false;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly options: { inline?: boolean; warn?: (code: string, error?: unknown) => void } = {}) {}

  /** Digests of a submission; on the worker thread unless it is unavailable. */
  async digest(kind: string, config: unknown, request: DigestRequest): Promise<SubmissionDigests> {
    const worker = this.options.inline || this.closed ? undefined : this.ensureWorker();
    if (!worker) return submissionDigests(kind, config, request);
    const id = this.next++;
    return await new Promise<SubmissionDigests>((resolve) => {
      const fallback = () => resolve(submissionDigests(kind, config, request));
      this.pending.set(id, { resolve, fallback });
      try { worker.postMessage({ id, kind, config, request }); }
      catch (error) { this.pending.delete(id); this.options.warn?.("SUBMISSION_DIGEST_WORKER_FAILED", error); fallback(); }
    });
  }

  /** Whether a worker thread currently serves digests (diagnostics and tests). */
  get threaded(): boolean { return this.worker !== undefined; }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = undefined;
    this.failAll();
    await worker?.terminate();
  }

  private ensureWorker(): Worker | undefined {
    if (this.worker) return this.worker;
    if (this.failures >= MAX_WORKER_FAILURES) return undefined;
    let worker: Worker;
    try { worker = new Worker(WORKER_SOURCE, { eval: true }); }
    catch (error) { this.failed(error); return undefined; }
    worker.unref();
    worker.on("message", (message: { id?: unknown; fingerprint?: unknown; items?: unknown; error?: unknown }) => {
      const entry = typeof message?.id === "number" ? this.pending.get(message.id) : undefined;
      if (!entry) return;
      this.pending.delete(message.id as number);
      const items = Array.isArray(message.items) ? message.items as SubmissionDigests["items"] : undefined;
      if (typeof message.fingerprint === "string" && items) entry.resolve({ fingerprint: message.fingerprint, items });
      else { this.options.warn?.("SUBMISSION_DIGEST_WORKER_FAILED", message.error); entry.fallback(); }
    });
    worker.on("error", (error) => { if (this.worker === worker) this.failed(error); });
    worker.on("exit", (code) => { if (this.worker === worker) this.failed(new Error(`Digest worker exited with code ${code}.`)); });
    this.worker = worker;
    return worker;
  }

  private failed(error: unknown): void {
    this.failures += 1;
    this.worker = undefined;
    this.options.warn?.("SUBMISSION_DIGEST_WORKER_FAILED", error);
    this.failAll();
  }

  private failAll(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.fallback();
  }
}
