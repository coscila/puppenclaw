import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import { stableHash, stableJson, SubmissionDigester, submissionDigests } from "../../src/advanced/digest.js";
import { AdvancedRuntime } from "../../src/advanced/runtime.js";
import { startParamsZod } from "../../src/shared/schema.js";
import type { ModelProviderConfig, SessionInfo } from "../../src/shared/types.js";

/**
 * Submission digests off the event loop: the digest worker computes exactly what the submission path computed inline
 * (stored fingerprints, item digests and blob keys must not change), and any worker failure falls back inline.
 */
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); delete process.env.TEST_MODEL_KEY; });
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The submission digest code before this change, verbatim (runtime.ts `hash` and `stable`, store.ts saveInput). */
const legacyHash = (input: unknown) => createHash("sha256").update(typeof input === "string" ? input : legacyStable(input)).digest("hex");
function legacyStable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(legacyStable).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${legacyStable(v)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }

const config = { id: "judge", assignment: "Judge", agent: "codex", modelProvider: { id: "judge", model: "judge-model", kind: "codex-openai-compatible" } };
const tricky = [
  "plain string",
  { messages: [{ role: "user", content: "Ünïcödé — “curly” \\ \u0000   😀" }], max_tokens: 3000, temperature: 0 },
  { z: 1, a: [true, null, -0, 1e21, 0.1], nested: { "b": { "10": "ten", "2": "two", "x": [] }, "ä": "umlaut", "A": "upper", "a": "lower" } },
  { "": "empty key", "\"quoted\"": ["\ud83d"] },
  JSON.parse("{\"messages\":[{\"role\":\"system\",\"content\":\"S\"},{\"role\":\"user\",\"content\":\"u\"}],\"itemCount\":40,\"stream\":false}")
];
const request = { configId: "judge", idempotencyKey: "k", concurrency: 60, items: tricky.map((input, index) => ({ id: `i${index}`, input })) };

describe("submission digests", () => {
  it("equal the digests the submission path computed inline before, on the worker thread as well", async () => {
    const expected = {
      fingerprint: legacyHash({ kind: "bulk", config, request }),
      items: request.items.map((item) => ({ digest: legacyHash(item.input), blob: sha256(JSON.stringify(item.input) ?? "null") }))
    };
    expect(stableJson(request)).toBe(legacyStable(request));
    expect(stableHash(request)).toBe(legacyHash(request));
    expect(submissionDigests("bulk", config, request)).toEqual(expected);
    const digester = new SubmissionDigester();
    cleanups.push(() => digester.close());
    expect(await digester.digest("bulk", config, request)).toEqual(expected);
    expect(digester.threaded).toBe(true);
    // Concurrent submissions each get their own answer.
    const many = await Promise.all(Array.from({ length: 20 }, (_, index) => digester.digest("bulk", config, { ...request, idempotencyKey: `k${index}` })));
    expect(many.map((entry) => entry.fingerprint)).toEqual(Array.from({ length: 20 }, (_, index) => legacyHash({ kind: "bulk", config, request: { ...request, idempotencyKey: `k${index}` } })));
  });

  it("falls back inline when the worker dies mid-request, and after closing", async () => {
    const digester = new SubmissionDigester();
    cleanups.push(() => digester.close());
    await digester.digest("bulk", config, request);
    const worker = (digester as unknown as { worker: Worker }).worker;
    const large = { ...request, items: Array.from({ length: 200 }, (_, index) => ({ id: `big${index}`, input: { messages: [{ role: "user", content: "x".repeat(50_000) + index }] } })) };
    const pending = digester.digest("bulk", config, large);
    await worker.terminate();
    expect(await pending).toEqual(submissionDigests("bulk", config, large));
    await digester.close();
    expect(digester.threaded).toBe(false);
    expect(await digester.digest("bulk", config, request)).toEqual(submissionDigests("bulk", config, request));
    const inline = new SubmissionDigester({ inline: true });
    expect(await inline.digest("bulk", config, request)).toEqual(submissionDigests("bulk", config, request));
    expect(inline.threaded).toBe(false);
  });

  it("stores the same fingerprint, item digests and input blob keys when a bulk submission is digested on the worker", async () => {
    const server = createServer(async (req, res) => { for await (const _chunk of req) { /* drain */ } res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ model: "judge-model", status: "completed", output_text: "T", usage: { input_tokens: 1, output_tokens: 1 } })); });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    process.env.TEST_MODEL_KEY = "test-secret";
    const provider: ModelProviderConfig = { id: "judge", model: "judge-model", kind: "codex-openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, authTokenEnv: "TEST_MODEL_KEY" };
    const results: Record<string, { fingerprint: string; digests: string[]; blobs: string[] }> = {};
    for (const mode of ["worker", "inline"] as const) {
      const runtime = await AdvancedRuntime.open(await mkdtemp(join("/tmp", "pcsd-")), { defaultLimit: 4 }, mode === "inline" ? { digests: { inline: true } } : {});
      cleanups.push(() => runtime.close());
      const params = startParamsZod.parse({ name: "main", agent: "codex", directory: "/tmp", task: "review", interactionMode: "execute", permissionMode: "approve-all",
        statisticsContext: { version: 1, chatId: "chat", attemptId: "attempt" }, modelProvider: provider,
        orchestration: { version: 1, revision: 1, workers: [{ id: "judge", assignment: "Judge", agent: "codex", modelProvider: provider }] } });
      const session = { ...params, state: "idle", warnings: [], transcript: [], createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() } as unknown as SessionInfo;
      runtime.attach({ start: async () => ({ content: [], details: {} }), quiesce: async () => {}, getSession: () => session, contribution: () => {} });
      await runtime.begin(session, params, "approve-all");
      const submitted = await new Promise<{ jobId: string }>((resolve, reject) => {
        const req = httpRequest({ socketPath: runtime.socket("main")!, path: "/bulk/submit", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
          let text = ""; res.on("data", (chunk) => { text += chunk; }); res.once("end", () => resolve(JSON.parse(text)));
        });
        req.once("error", reject); req.end(JSON.stringify({ configId: "judge", idempotencyKey: "digests", items: request.items }));
      });
      const job = runtime.store.job(submitted.jobId, { overlay: false })!;
      const db = (runtime.store as unknown as { db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } } }).db;
      const blobs = (db.prepare("SELECT digest FROM item_inputs WHERE job_id=? ORDER BY item_id").all(submitted.jobId) as { digest: string }[]).map((row) => row.digest);
      results[mode] = { fingerprint: job.fingerprint, digests: job.results.map((result) => result.promptSha256), blobs };
      expect((runtime as unknown as { digester: SubmissionDigester }).digester.threaded, mode).toBe(mode === "worker");
    }
    expect(results.worker).toEqual(results.inline);
    const parsed = (JSON.parse(JSON.stringify({ configId: "judge", idempotencyKey: "digests", items: request.items })) as typeof request);
    expect(results.worker!.digests).toEqual(parsed.items.map((item) => legacyHash(item.input)));
    expect(results.worker!.blobs).toEqual([...parsed.items].sort((a, b) => a.id.localeCompare(b.id)).map((item) => sha256(JSON.stringify(item.input))));
  });
});
