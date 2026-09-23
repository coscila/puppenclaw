import { z } from "zod";

import type { NormalizedUsage } from "./types.js";
import { normalizeCodexUsage } from "./usage.js";

/**
 * Wire contract v1 of the OCSL Codex wrapper's per-thread usage line. For a
 * direct `codex exec --json` invocation the wrapper appends exactly one
 *
 *   {"type":"ocsl.model_usage","version":1,"threads":[...]}
 *
 * line to stdout after Codex exited, carrying THIS invocation's usage delta per
 * native thread (main orchestrator thread plus multi-agent subagents, whose
 * events `codex exec --json` never streams). It is wrapper metadata, never a
 * Codex event.
 */
export const OCSL_MODEL_USAGE_TYPE = "ocsl.model_usage";
export const MAX_MODEL_USAGE_THREADS = 256;

export type ModelUsageRole = "main" | "subagent";

const tokenCount = z.number().int().min(0);
const identifier = z.string().min(1).max(512);

const threadUsageZod = z.object({
  input_tokens: tokenCount,
  cached_input_tokens: tokenCount,
  cache_write_input_tokens: tokenCount.default(0),
  output_tokens: tokenCount,
  reasoning_output_tokens: tokenCount,
  total_tokens: tokenCount
});

export type CodexThreadUsage = z.infer<typeof threadUsageZod>;

const threadZod = z
  .object({
    threadId: identifier,
    parentThreadId: identifier.nullable(),
    role: z.enum(["main", "subagent"]),
    agentRole: z.string().max(512).nullable(),
    model: identifier,
    usage: threadUsageZod
  })
  .refine((thread) => (thread.role === "main") === (thread.parentThreadId === null), {
    message: "A main thread has no parent thread; a subagent always has one."
  });

export const ocslModelUsageLineZod = z
  .object({
    type: z.literal(OCSL_MODEL_USAGE_TYPE),
    version: z.literal(1),
    threads: z.array(threadZod).min(1).max(MAX_MODEL_USAGE_THREADS)
  })
  .refine((line) => new Set(line.threads.map((thread) => thread.threadId)).size === line.threads.length, {
    message: "Thread ids must be unique."
  });

/** Threads of one invocation grouped by (role, model); usage keeps the Codex field names. */
export type ModelUsageGroup = {
  role: ModelUsageRole;
  model: string;
  threads: number;
  usage: CodexThreadUsage;
};

const USAGE_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens"
] as const satisfies ReadonlyArray<keyof CodexThreadUsage>;

/**
 * Validates one `ocsl.model_usage` line and groups its threads by (role,
 * model), main groups first, each in first-seen order. Returns null for any
 * invalid line (callers then keep today's main-thread-only accounting) and for
 * a line without any nonzero thread usage.
 */
export function parseOcslModelUsage(raw: unknown): ModelUsageGroup[] | null {
  const parsed = ocslModelUsageLineZod.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const groups = new Map<string, ModelUsageGroup>();
  for (const role of ["main", "subagent"] as const) {
    for (const thread of parsed.data.threads) {
      if (thread.role !== role || USAGE_KEYS.every((key) => thread.usage[key] === 0)) {
        continue;
      }
      const groupKey = JSON.stringify([role, thread.model]);
      const group = groups.get(groupKey);
      if (group == null) {
        groups.set(groupKey, { role, model: thread.model, threads: 1, usage: { ...thread.usage } });
        continue;
      }
      group.threads += 1;
      for (const key of USAGE_KEYS) {
        group.usage[key] += thread.usage[key];
        if (!Number.isSafeInteger(group.usage[key])) {
          return null;
        }
      }
    }
  }
  return groups.size > 0 ? [...groups.values()] : null;
}

/** Disjoint-bucket usage of one group (same normalisation as Codex events). */
export function normalizeModelUsageGroup(group: ModelUsageGroup): NormalizedUsage {
  return normalizeCodexUsage(group.usage);
}

export function sumNormalizedUsage(values: readonly NormalizedUsage[]): NormalizedUsage {
  const total: NormalizedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  for (const value of values) {
    total.input += value.input;
    total.output += value.output;
    total.cacheRead += value.cacheRead;
    total.cacheWrite += value.cacheWrite;
    total.total += value.total;
  }
  return total;
}
