import { z } from "zod";

import { PuppenclawError } from "../shared/errors.js";
import { REASONING_MODE_VALUES } from "../shared/reasoning.js";
import { canonicalJson, sha256Hex } from "./fingerprint.js";

/**
 * Instrument mode (pcp/2 instrumentMode:1). coscila installs a measurement
 * instrument bundle under the opaque digest its registry computed
 * (ocsl-instrument-digest-v1); the daemon never recomputes that digest, it only
 * allow-lists what was installed. A bulk job naming an installed digest takes
 * its system prompt, output budget, sampling settings and response schema from
 * the bundle; item inputs supply only the messages.
 *
 * `transport.messages` (capability instrumentVerbatim:1) says how item messages
 * reach the upstream:
 * - `policy-wrapped` (the default, and what a bundle without `transport` means):
 *   the system prompt is the broker's worker policy plus the instrument prompt,
 *   and items carry only user and assistant messages.
 * - `verbatim`: an item carries the executor's messages exactly as built,
 *   system message included. The daemon checks them (and any request setting
 *   the item repeats) against the bundle and sends them unchanged in the
 *   chat-completions request of the worker's model and the bundle's settings,
 *   with nothing added (see verbatimInstrumentCall). A verbatim bundle carries
 *   no response schema (verbatimBundleProblem): the daemon would have to write
 *   the response format and parse the answer itself, so the executor could no
 *   longer recompute the request or read the model's own text. Only run
 *   principals (kind run, bound to a study run) granted the digest may use such
 *   an instrument.
 */
export const INSTRUMENT_MESSAGE_MODES = ["policy-wrapped", "verbatim"] as const;
export type InstrumentMessageMode = (typeof INSTRUMENT_MESSAGE_MODES)[number];

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
  requiredModelFingerprint: z.string().min(1).max(512).nullable(),
  transport: z.object({ messages: z.enum(INSTRUMENT_MESSAGE_MODES) }).strict().optional()
}).strict();
export type InstrumentBundle = z.infer<typeof instrumentBundleZod>;

/** How an installed bundle's item messages reach the upstream; a bundle without `transport` is policy-wrapped. */
export function instrumentMessageMode(bundle: Pick<InstrumentBundle, "transport">): InstrumentMessageMode {
  return bundle.transport?.messages ?? "policy-wrapped";
}

/**
 * Why a bundle cannot be installed as a verbatim instrument, or null. A verbatim call is the executor's request byte
 * for byte, so the bundle may not make the daemon add a response format (and parse the answer) on its behalf.
 */
export function verbatimBundleProblem(bundle: InstrumentBundle): string | null {
  if (instrumentMessageMode(bundle) !== "verbatim") return null;
  return bundle.responseSchema != null ? "A verbatim instrument carries no responseSchema: its calls are sent byte for byte as the executor built them and answered with the model's own text." : null;
}

/** The message mode of a bundle as the allow-list returns it (validated when installed), for listings. */
export function storedMessageMode(bundle: Record<string, unknown>): InstrumentMessageMode {
  const transport = bundle.transport;
  return transport !== null && typeof transport === "object" && (transport as { messages?: unknown }).messages === "verbatim" ? "verbatim" : "policy-wrapped";
}

/**
 * The bundle as the allow-list stores it. A policy-wrapped bundle is stored
 * without `transport`, whether the PUT spelled the default out or not: the same
 * instrument then has one stored form (a repeated PUT stays idempotent), and a
 * daemon from before transport modes, whose bundle schema is strict, reads it
 * unchanged. A verbatim bundle keeps its `transport`, so such a daemon refuses
 * it outright instead of running it policy-wrapped.
 */
export function storedInstrumentBundle(bundle: InstrumentBundle): InstrumentBundle {
  if (instrumentMessageMode(bundle) === "verbatim") return bundle;
  const { transport: _transport, ...stored } = bundle;
  return stored;
}

/** Joins the broker's worker policy and the instrument prompt into the one system prompt (policy-wrapped bundles). */
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
 * required_model_fingerprint}, where the system prompt is the one the upstream
 * receives: worker policy plus instrument prompt when policy-wrapped, the
 * instrument prompt alone when verbatim. A verbatim bundle adds
 * `messages: "verbatim"`; a policy-wrapped one keeps the digest it had before
 * transport modes existed. A receipt's settingsSha256 digests the effective
 * settings of one call instead (model and per-call max_tokens included).
 */
export function installedSettingsSha256(workerPolicy: string, bundle: InstrumentBundle): string {
  const verbatim = instrumentMessageMode(bundle) === "verbatim";
  return sha256Hex(canonicalJson({
    system_prompt_sha256: sha256Hex(verbatim ? bundle.systemPrompt : instrumentSystemPrompt(workerPolicy, bundle)),
    response_schema_sha256: bundle.responseSchema == null ? null : sha256Hex(canonicalJson(bundle.responseSchema)),
    temperature: bundle.temperature,
    seed: bundle.seed,
    reasoning: bundle.reasoning,
    max_tokens: { perItem: bundle.maxOutputTokens.perItem, minimum: bundle.maxOutputTokens.minimum },
    items_per_call: bundle.itemsPerCall,
    required_model_fingerprint: bundle.requiredModelFingerprint,
    ...(verbatim ? { messages: "verbatim" } : {})
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

// ------------------------------------------------------------------ verbatim instruments

/** Closed failure code of a verbatim item the daemon refuses to send (a 400-class refusal, never retried). */
export const INSTRUMENT_MESSAGE_MISMATCH = "INSTRUMENT_MESSAGE_MISMATCH";
/** Request settings a verbatim item may repeat; each must then equal what the daemon sends. */
export const VERBATIM_SETTING_FIELDS = ["model", "max_tokens", "temperature", "seed", "reasoning_effort", "stream"] as const;
/** Fields a verbatim item may carry: its messages, the entry count it declares (never sent upstream) and the settings. */
const VERBATIM_ITEM_FIELDS = new Set<string>(["messages", "itemCount", ...VERBATIM_SETTING_FIELDS]);
const TOOL_FIELDS = ["tools", "tool_choice", "functions", "function_call", "parallel_tool_calls"];
const VERBATIM_ROLES = new Set(["system", "user", "assistant"]);

/**
 * One verbatim call: the chat-completions request the daemon sends and the entry count the item declared.
 * `request` is exactly {model, messages, max_tokens, temperature, seed (only when the bundle sets one),
 * reasoning_effort, stream: false}: the worker's model, the messages as submitted (the same array) and the
 * bundle's settings. A census executor's own request has these keys, so it can recompute the request digest.
 */
export type VerbatimCall = { request: Record<string, unknown>; itemCount: number };

const plainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** Caller-supplied values and names in a refusal are bounded: an item cannot grow the error it is stored with. */
const SHOWN_MAX = 64, NAMES_MAX = 8;
const bounded = (text: string): string => text.length > SHOWN_MAX ? `${text.slice(0, SHOWN_MAX - 1)}…` : text;
const shown = (value: unknown): string => value === undefined ? "absent" : bounded(JSON.stringify(value) ?? String(value));
const names = (keys: string[]): string => keys.slice(0, NAMES_MAX).map(bounded).join(", ") + (keys.length > NAMES_MAX ? ` and ${keys.length - NAMES_MAX} more` : "");
const digestHead = (text: string): string => sha256Hex(text).slice(0, 12);
function mismatch(reason: string): PuppenclawError {
  return new PuppenclawError(INSTRUMENT_MESSAGE_MISMATCH, `Verbatim instrument call refused: ${reason}.`);
}

/**
 * Checks one verbatim item against the installed bundle and the worker's model, and builds the request the
 * daemon sends for it. The item carries the executor's messages exactly as built and `itemCount`, the number
 * of instrument entries the call carries; it may repeat the settings of the request it built (`model`,
 * `max_tokens`, `temperature`, `seed`, `reasoning_effort`, `stream`). It is refused (a PuppenclawError with
 * code INSTRUMENT_MESSAGE_MISMATCH) unless:
 * - the first message is a system message equal to the installed `systemPrompt` byte for byte, and no other
 *   message is a system message;
 * - every message is exactly {role, content} with a string content and the role system, user or assistant,
 *   and at least one is a user message;
 * - 1 ≤ itemCount ≤ itemsPerCall;
 * - every setting it repeats equals what is sent: `model` the worker's model, `max_tokens`
 *   max(minimum, perItem × itemCount), `temperature` and `reasoning_effort` the bundle's temperature and
 *   reasoning, `seed` the bundle's (null or absent when the bundle has none), `stream` false;
 * - it names no tools and no other field.
 */
export function verbatimInstrumentCall(bundle: InstrumentBundle, input: unknown, model: string): VerbatimCall {
  if (!plainObject(input)) throw mismatch("an item is an object {messages, itemCount} with the messages exactly as the executor built them");
  const tools = TOOL_FIELDS.filter((key) => Object.hasOwn(input, key));
  if (tools.length > 0) throw mismatch(`verbatim calls carry no tools (${tools.join(", ")})`);
  const extra = Object.keys(input).filter((key) => !VERBATIM_ITEM_FIELDS.has(key));
  if (extra.length > 0) throw mismatch(`fields outside the instrument request: ${names(extra)}`);
  const messages = input.messages;
  if (!Array.isArray(messages) || messages.length === 0) throw mismatch("messages must be a non-empty array");
  for (const [index, message] of messages.entries()) {
    if (!plainObject(message)) throw mismatch(`message ${index} is not an object`);
    const keys = Object.keys(message);
    if (keys.length !== 2 || !keys.includes("role") || !keys.includes("content")) throw mismatch(`message ${index} must carry exactly role and content`);
    if (typeof message.role !== "string" || !VERBATIM_ROLES.has(message.role)) throw mismatch(`message ${index} has role ${shown(message.role)}; only system, user and assistant are sent`);
    if (typeof message.content !== "string") throw mismatch(`message ${index} content must be a string`);
  }
  const [system, ...rest] = messages as { role: string; content: string }[];
  if (system!.role !== "system") throw mismatch("the first message must be the instrument's system message");
  if (system!.content !== bundle.systemPrompt) {
    throw mismatch(`the system message differs from the installed instrument prompt (sha256 ${digestHead(system!.content)}… of ${system!.content.length} characters; installed ${digestHead(bundle.systemPrompt)}… of ${bundle.systemPrompt.length})`);
  }
  if (rest.some((message) => message.role === "system")) throw mismatch("only the first message may be a system message");
  if (!rest.some((message) => message.role === "user")) throw mismatch("a call needs at least one user message");
  const itemCount = input.itemCount;
  if (typeof itemCount !== "number" || !Number.isSafeInteger(itemCount) || itemCount < 1 || itemCount > bundle.itemsPerCall) {
    throw mismatch(`itemCount ${shown(itemCount)} must declare the call's entry count, 1 to ${bundle.itemsPerCall}`);
  }
  const maxTokens = instrumentMaxTokens(bundle, itemCount);
  if (input.model !== undefined && input.model !== model) throw mismatch(`model ${shown(input.model)} is not the worker's model ${shown(model)}`);
  if (input.max_tokens !== undefined && input.max_tokens !== maxTokens) {
    throw mismatch(`max_tokens ${shown(input.max_tokens)} differs from max(${bundle.maxOutputTokens.minimum}, ${bundle.maxOutputTokens.perItem} × ${itemCount}) = ${maxTokens}`);
  }
  if (input.temperature !== undefined && input.temperature !== bundle.temperature) throw mismatch(`temperature ${shown(input.temperature)} differs from the instrument's ${bundle.temperature}`);
  if (input.seed !== undefined && (bundle.seed === null ? input.seed !== null : input.seed !== bundle.seed)) {
    throw mismatch(`seed ${shown(input.seed)} differs from the instrument's ${bundle.seed === null ? "absent seed" : bundle.seed}`);
  }
  if (input.reasoning_effort !== undefined && input.reasoning_effort !== bundle.reasoning) throw mismatch(`reasoning_effort ${shown(input.reasoning_effort)} differs from the instrument's ${shown(bundle.reasoning)}`);
  if (input.stream !== undefined && input.stream !== false) throw mismatch("verbatim calls are not streamed (stream must be false or absent)");
  return {
    request: { model, messages, max_tokens: maxTokens, temperature: bundle.temperature, ...(bundle.seed !== null ? { seed: bundle.seed } : {}), reasoning_effort: bundle.reasoning, stream: false },
    itemCount
  };
}
