import type { StatisticsTokens } from "./types.js";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
const first = (
  value: Record<string, unknown>,
  keys: string[],
): number | null => {
  for (const key of keys) {
    const n = count(value[key]);
    if (n !== null) return n;
  }
  return null;
};
export function unavailableTokens(): StatisticsTokens {
  return {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    reasoning: null,
    total: null,
    quality: "unavailable",
  };
}
/** New statistics input is inclusive; cache and reasoning are subsets, never added to total. */
export function statisticsTokens(
  raw: unknown,
  format: "acp" | "codex" | "anthropic",
  final: boolean,
): StatisticsTokens {
  const value = object(raw);
  const inputBase = first(
    value,
    format === "acp"
      ? ["inputTokens", "input"]
      : ["input_tokens", "inputTokens"],
  );
  const output = first(
    value,
    format === "acp"
      ? ["outputTokens", "output"]
      : ["output_tokens", "outputTokens"],
  );
  const cacheRead = first(
    value,
    format === "codex"
      ? ["cached_input_tokens", "cachedInputTokens"]
      : ["cachedReadTokens", "cacheRead", "cache_read_input_tokens"],
  );
  const cacheWrite =
    format === "codex"
      ? 0
      : first(value, [
          "cachedWriteTokens",
          "cacheWrite",
          "cache_creation_input_tokens",
        ]);
  const inclusive = format === "codex";
  const input =
    inputBase === null
      ? null
      : inclusive
        ? inputBase
        : cacheRead !== null && cacheWrite !== null
          ? inputBase + cacheRead + cacheWrite
          : null;
  const providedTotal = first(value, ["totalTokens", "total_tokens", "total"]);
  const total =
    input !== null && output !== null ? input + output : providedTotal;
  const reasoning =
    first(value, ["reasoning_output_tokens", "reasoningTokens"]) ??
    first(object(value.output_tokens_details), ["reasoning_tokens"]);
  if (
    [input, output, cacheRead, cacheWrite, total, reasoning].some(
      (n) => n !== null && !Number.isSafeInteger(n),
    )
  )
    return unavailableTokens();
  if (input === null && output === null && total === null)
    return unavailableTokens();
  return {
    input,
    output,
    cacheRead:
      input !== null && cacheRead !== null
        ? Math.min(input, cacheRead)
        : cacheRead,
    cacheWrite,
    reasoning:
      output !== null && reasoning !== null
        ? Math.min(output, reasoning)
        : reasoning,
    total,
    quality:
      final && input !== null && output !== null ? "measured" : "partial",
  };
}
