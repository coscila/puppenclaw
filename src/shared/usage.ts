import type { NormalizedUsage } from "./types.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readUsageNumber(source: JsonRecord, keys: readonly string[]): number {
  for (const key of keys) {
    const value = asFiniteNumber(source[key]);
    if (value != null) {
      return value;
    }
  }
  return 0;
}

/**
 * Normalize a provider `usage` payload into the canonical four-bucket shape,
 * accepting the superset of field-name variants that ACP adapters (Claude /
 * Codex) and their underlying providers emit. Mirrors OpenClaw core's
 * `UsageLike` → `NormalizedUsage`. `total` is always the sum of the four
 * buckets (an explicit provider total is ignored — it usually excludes cache).
 */
export function normalizeUsage(raw: unknown): NormalizedUsage {
  const record = isRecord(raw) ? raw : {};
  const source: JsonRecord = isRecord(record.usage)
    ? { ...record, ...(record.usage as JsonRecord) }
    : record;
  const input = readUsageNumber(source, [
    "input",
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens"
  ]);
  const output = readUsageNumber(source, [
    "output",
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens"
  ]);
  let cacheRead = readUsageNumber(source, [
    "cacheRead",
    "cache_read",
    "cacheReadInputTokens",
    "cache_read_input_tokens",
    "cachedReadTokens",
    "cacheReadTokens",
    "cachedTokens",
    "cached_tokens"
  ]);
  if (cacheRead === 0 && isRecord(source.prompt_tokens_details)) {
    cacheRead = asFiniteNumber((source.prompt_tokens_details as JsonRecord).cached_tokens) ?? 0;
  }
  const cacheWrite = readUsageNumber(source, [
    "cacheWrite",
    "cache_write",
    "cacheCreationInputTokens",
    "cache_creation_input_tokens",
    "cachedWriteTokens",
    "cacheWriteTokens"
  ]);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite
  };
}

/**
 * Normalize a Codex (`codex exec --json`) usage payload — the object on
 * `turn.completed.usage` or `token_count.info.{total,last}_token_usage`. Unlike
 * the Anthropic/ACP shape, Codex's `input_tokens` is the TOTAL prompt tokens
 * INCLUDING `cached_input_tokens` and (codex >= 0.147)
 * `cache_write_input_tokens`, so we split them into disjoint buckets (fresh
 * input vs. cache read vs. cache write) to avoid double-counting the
 * recomputed total. Cache writes are carved out of the uncached input, so the
 * total never changes because of them.
 */
export function normalizeCodexUsage(raw: unknown): NormalizedUsage {
  const source = isRecord(raw) ? raw : {};
  const inputTotal = readUsageNumber(source, ["input_tokens", "inputTokens"]);
  const cachedInput = readUsageNumber(source, [
    "cached_input_tokens",
    "cachedInputTokens"
  ]);
  const cacheWriteInput = readUsageNumber(source, [
    "cache_write_input_tokens",
    "cacheWriteInputTokens"
  ]);
  const output = readUsageNumber(source, ["output_tokens", "outputTokens"]);
  const cacheRead = Math.min(cachedInput, inputTotal);
  const uncached = Math.max(0, inputTotal - cacheRead);
  const cacheWrite = Math.min(Math.max(0, cacheWriteInput), uncached);
  const input = uncached - cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite
  };
}

export function hasNonzeroUsage(usage: NormalizedUsage): boolean {
  return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0;
}
