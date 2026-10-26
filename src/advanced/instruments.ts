import { z } from "zod";

import { REASONING_MODE_VALUES } from "../shared/reasoning.js";
import { canonicalJson, sha256Hex } from "./fingerprint.js";

/**
 * Instrument mode (pcp/2 instrumentMode:1). coscila installs a measurement
 * instrument bundle under the opaque digest its registry computed
 * (ocsl-instrument-digest-v1); the daemon never recomputes that digest, it only
 * allow-lists what was installed. A bulk job naming an installed digest takes
 * its system prompt, output budget, sampling settings and response schema from
 * the bundle; item inputs supply only the messages.
 */
export const instrumentBundleZod = z.object({
  instrumentId: z.string().min(1).max(200),
  version: z.union([z.number().int().nonnegative().safe(), z.string().min(1).max(64)]),
  systemPrompt: z.string().min(1).max(1_048_576),
  responseSchema: z.record(z.string(), z.unknown()).nullable(),
  maxOutputTokens: z.object({ perItem: z.number().int().positive().safe(), minimum: z.number().int().nonnegative().safe() }).strict(),
  temperature: z.number().min(0).max(2),
  seed: z.number().int().safe().nullable(),
  reasoning: z.enum(REASONING_MODE_VALUES),
  itemsPerCall: z.number().int().positive().max(100_000),
  requiredModelFingerprint: z.string().min(1).max(512).nullable()
}).strict();
export type InstrumentBundle = z.infer<typeof instrumentBundleZod>;

/** Joins the broker's worker policy and the instrument prompt into the one system prompt. */
export function instrumentSystemPrompt(workerPolicy: string, bundle: Pick<InstrumentBundle, "systemPrompt">): string {
  return `${workerPolicy}\n\n${bundle.systemPrompt}`;
}

/** Output-token budget of one call: max(minimum, perItem × items in the call). */
export function instrumentMaxTokens(bundle: Pick<InstrumentBundle, "maxOutputTokens">, items: number): number {
  return Math.max(bundle.maxOutputTokens.minimum, bundle.maxOutputTokens.perItem * items);
}

/**
 * Digest of what the daemon will apply for this bundle, returned by the PUT:
 * sha256 of the canonical JSON of {system_prompt_sha256, response_schema_sha256,
 * temperature, seed, reasoning, max_tokens: {perItem, minimum}, items_per_call,
 * required_model_fingerprint}. A receipt's settingsSha256 digests the effective
 * settings of one call instead (model and per-call max_tokens included).
 */
export function installedSettingsSha256(workerPolicy: string, bundle: InstrumentBundle): string {
  return sha256Hex(canonicalJson({
    system_prompt_sha256: sha256Hex(instrumentSystemPrompt(workerPolicy, bundle)),
    response_schema_sha256: bundle.responseSchema == null ? null : sha256Hex(canonicalJson(bundle.responseSchema)),
    temperature: bundle.temperature,
    seed: bundle.seed,
    reasoning: bundle.reasoning,
    max_tokens: { perItem: bundle.maxOutputTokens.perItem, minimum: bundle.maxOutputTokens.minimum },
    items_per_call: bundle.itemsPerCall,
    required_model_fingerprint: bundle.requiredModelFingerprint
  }));
}

const messageZod = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
  type: z.literal("message").optional()
}).strict();

/** Item input in instrument mode: the call's messages and how many instrument items they carry. */
export const instrumentItemInputZod = z.union([
  z.string().min(1),
  z.object({ messages: z.array(messageZod).min(1), itemCount: z.number().int().positive().safe().optional() }).strict()
]);

export type InstrumentCall = { messages: z.infer<typeof messageZod>[]; itemCount: number };

/** Validates one item for an installed bundle; only the user/assistant messages and the item count vary per call. */
export function instrumentCall(bundle: InstrumentBundle, input: unknown): InstrumentCall {
  const parsed = instrumentItemInputZod.safeParse(input);
  if (!parsed.success) throw new Error("Instrument items take a string or {messages, itemCount}; request settings come from the installed instrument.");
  if (typeof parsed.data === "string") return { messages: [{ role: "user", content: parsed.data }], itemCount: Math.min(1, bundle.itemsPerCall) };
  const itemCount = parsed.data.itemCount ?? bundle.itemsPerCall;
  if (itemCount > bundle.itemsPerCall) throw new Error(`An instrument call carries at most ${bundle.itemsPerCall} items.`);
  return { messages: parsed.data.messages, itemCount };
}
