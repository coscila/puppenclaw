import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { brokerReceiptPayload, outputDigest, outputText } from "../../src/advanced/outbox.js";
import type { ItemResult } from "../../src/advanced/types.js";

/**
 * The output digest of a broker receipt as a reader outside the daemon recomputes it from a stored item output. The
 * vectors are shared byte for byte with the census replay of the review companion (coscila-review
 * tests/fixtures/broker/output-digest-vectors.json), which asserts the same values with its own JSON parser.
 */
const VECTORS = join(import.meta.dirname, "..", "fixtures", "output-digest-vectors.json");
const VECTORS_SHA256 = "8650791998aa91a44db66b019c7408a1daf648e7d5549a768e296b3efe93baf1";

type Vector = { name: string; outputJson?: string; text: string; sha256: string; bytes: number };

describe("output digest vectors", () => {
  it("are the shared file", async () => {
    expect(createHash("sha256").update(await readFile(VECTORS)).digest("hex")).toBe(VECTORS_SHA256);
  });

  it("give the text, sha256 and bytes outputDigest computes for each output", async () => {
    const { vectors } = JSON.parse(await readFile(VECTORS, "utf8")) as { vectors: Vector[] };
    expect(vectors.length).toBeGreaterThanOrEqual(10);
    for (const vector of vectors) {
      const output: unknown = vector.outputJson === undefined ? undefined : JSON.parse(vector.outputJson);
      expect(outputText(output), vector.name).toBe(vector.text);
      expect(outputDigest(output), vector.name).toEqual({ digest: vector.sha256, bytes: vector.bytes, text: vector.text });
    }
  });

  it("are the digests a receipt carries for the item's output", async () => {
    const { vectors } = JSON.parse(await readFile(VECTORS, "utf8")) as { vectors: Vector[] };
    for (const vector of vectors) {
      const item: ItemResult = { id: "item", state: "completed", providerId: "local", model: "m", promptSha256: "p", usage: null,
        ...(vector.outputJson === undefined ? {} : { output: JSON.parse(vector.outputJson) as unknown }) };
      const receipt = brokerReceiptPayload({ jobId: "job", instrumentDigest: null, item, fallbackFingerprint: "f", fallbackSettingsSha256: "s",
        receipt: { model: "m", usage: { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, total: null, quality: "unavailable" }, createdAt: "t", updatedAt: "t" } });
      expect([receipt.outputDigest, receipt.outputBytes], vector.name).toEqual([vector.sha256, vector.bytes]);
    }
  });
});
