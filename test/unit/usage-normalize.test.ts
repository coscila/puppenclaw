import { describe, expect, it } from "vitest";

import {
  hasNonzeroUsage,
  normalizeCodexUsage,
  normalizeUsage
} from "../../src/shared/usage.js";

describe("normalizeUsage", () => {
  it("normalizes snake_case Anthropic-style fields", () => {
    expect(
      normalizeUsage({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 3
      })
    ).toEqual({
      input: 100,
      output: 20,
      cacheRead: 5,
      cacheWrite: 3,
      total: 128
    });
  });

  it("normalizes camelCase provider fields", () => {
    expect(
      normalizeUsage({
        inputTokens: 40,
        outputTokens: 8,
        cacheReadInputTokens: 6,
        cacheCreationInputTokens: 2
      })
    ).toEqual({
      input: 40,
      output: 8,
      cacheRead: 6,
      cacheWrite: 2,
      total: 56
    });
  });

  it("normalizes the Claude ACP adapter result.usage shape", () => {
    expect(
      normalizeUsage({
        inputTokens: 200,
        outputTokens: 40,
        cachedReadTokens: 15,
        cachedWriteTokens: 9
      })
    ).toEqual({
      input: 200,
      output: 40,
      cacheRead: 15,
      cacheWrite: 9,
      total: 264
    });
  });

  it("accepts already-canonical field names", () => {
    expect(
      normalizeUsage({
        input: 10,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1
      })
    ).toEqual({
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      total: 17
    });
  });

  it("normalizes OpenAI-style prompt/completion fields with nested cached_tokens", () => {
    expect(
      normalizeUsage({
        prompt_tokens: 55,
        completion_tokens: 12,
        prompt_tokens_details: {
          cached_tokens: 9
        }
      })
    ).toEqual({
      input: 55,
      output: 12,
      cacheRead: 9,
      cacheWrite: 0,
      total: 76
    });
  });

  it("normalizes camelCase OpenAI-style promptTokens/completionTokens", () => {
    expect(
      normalizeUsage({
        promptTokens: 21,
        completionTokens: 7,
        cachedTokens: 4,
        cache_write: 2
      })
    ).toEqual({
      input: 21,
      output: 7,
      cacheRead: 4,
      cacheWrite: 2,
      total: 34
    });
  });

  it("reads top-level cached_tokens and cache_read aliases", () => {
    expect(normalizeUsage({ cached_tokens: 11 }).cacheRead).toBe(11);
    expect(normalizeUsage({ cache_read: 13 }).cacheRead).toBe(13);
  });

  it("unwraps a nested usage object", () => {
    expect(
      normalizeUsage({
        used: 123,
        size: 4096,
        usage: {
          prompt_tokens: 30,
          completion_tokens: 5,
          prompt_tokens_details: {
            cached_tokens: 2
          }
        }
      })
    ).toEqual({
      input: 30,
      output: 5,
      cacheRead: 2,
      cacheWrite: 0,
      total: 37
    });
  });

  it("prefers nested usage fields over outer fields for the same bucket", () => {
    const normalized = normalizeUsage({
      input_tokens: 999,
      usage: {
        input_tokens: 7,
        output_tokens: 1
      }
    });
    expect(normalized.input).toBe(7);
    expect(normalized.output).toBe(1);
  });

  it("defaults missing fields to zero", () => {
    expect(normalizeUsage({ output_tokens: 6 })).toEqual({
      input: 0,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
      total: 6
    });
    expect(normalizeUsage({})).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0
    });
  });

  it("returns all zeros for non-object input", () => {
    const zeros = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0
    };
    expect(normalizeUsage(null)).toEqual(zeros);
    expect(normalizeUsage(undefined)).toEqual(zeros);
    expect(normalizeUsage("usage")).toEqual(zeros);
    expect(normalizeUsage(42)).toEqual(zeros);
    expect(normalizeUsage([{ input_tokens: 9 }])).toEqual(zeros);
  });

  it("ignores non-finite and non-numeric values, falling through to later aliases", () => {
    const normalized = normalizeUsage({
      input: Number.NaN,
      inputTokens: "12",
      input_tokens: 8,
      output: Number.POSITIVE_INFINITY,
      output_tokens: 3
    });
    expect(normalized.input).toBe(8);
    expect(normalized.output).toBe(3);
  });

  it("computes total as the sum of the four buckets, ignoring an explicit provider total", () => {
    const normalized = normalizeUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
      total: 999_999
    });
    expect(normalized.total).toBe(20);
    expect(normalized.total).toBe(
      normalized.input + normalized.output + normalized.cacheRead + normalized.cacheWrite
    );
  });
});

describe("normalizeCodexUsage", () => {
  it("splits codex input_tokens (cache-inclusive) into disjoint buckets", () => {
    // Codex reports input_tokens INCLUDING cached_input_tokens; the normalizer
    // must split them so the recomputed total does not double-count the cache.
    expect(
      normalizeCodexUsage({
        input_tokens: 1000,
        cached_input_tokens: 300,
        output_tokens: 120,
        reasoning_output_tokens: 40,
        total_tokens: 1120
      })
    ).toEqual({
      input: 700,
      output: 120,
      cacheRead: 300,
      cacheWrite: 0,
      total: 1120
    });
  });

  it("accepts camelCase codex fields", () => {
    expect(
      normalizeCodexUsage({
        inputTokens: 50,
        cachedInputTokens: 10,
        outputTokens: 8
      })
    ).toEqual({
      input: 40,
      output: 8,
      cacheRead: 10,
      cacheWrite: 0,
      total: 58
    });
  });

  it("handles no cache (cached_input_tokens absent)", () => {
    expect(normalizeCodexUsage({ input_tokens: 30, output_tokens: 5 })).toEqual({
      input: 30,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      total: 35
    });
  });

  it("keeps codex cache_write_input_tokens as a subset of input without changing the total", () => {
    expect(
      normalizeCodexUsage({
        input_tokens: 1000,
        cached_input_tokens: 300,
        cache_write_input_tokens: 200,
        output_tokens: 120,
        total_tokens: 1120
      })
    ).toEqual({ input: 500, output: 120, cacheRead: 300, cacheWrite: 200, total: 1120 });
    // A cache write can never exceed the uncached input it is part of.
    expect(
      normalizeCodexUsage({
        input_tokens: 100,
        cached_input_tokens: 90,
        cache_write_input_tokens: 50,
        output_tokens: 1
      })
    ).toEqual({ input: 0, output: 1, cacheRead: 90, cacheWrite: 10, total: 101 });
  });

  it("clamps cached over input and returns zeros for non-object input", () => {
    expect(
      normalizeCodexUsage({
        input_tokens: 5,
        cached_input_tokens: 9,
        output_tokens: 2
      })
    ).toEqual({ input: 0, output: 2, cacheRead: 5, cacheWrite: 0, total: 7 });
    expect(normalizeCodexUsage(null)).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0
    });
  });
});

describe("hasNonzeroUsage", () => {
  it("returns false when every bucket is zero", () => {
    expect(
      hasNonzeroUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })
    ).toBe(false);
  });

  it("returns true when any single bucket is nonzero", () => {
    expect(
      hasNonzeroUsage({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 })
    ).toBe(true);
    expect(
      hasNonzeroUsage({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0, total: 1 })
    ).toBe(true);
    expect(
      hasNonzeroUsage({ input: 0, output: 0, cacheRead: 1, cacheWrite: 0, total: 1 })
    ).toBe(true);
    expect(
      hasNonzeroUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1, total: 1 })
    ).toBe(true);
  });
});
