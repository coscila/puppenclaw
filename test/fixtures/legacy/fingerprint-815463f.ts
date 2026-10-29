// Verbatim copy of src/advanced/fingerprint.ts at 815463f.
import { createHash } from "node:crypto";

/**
 * Provenance digests carried by every broker receipt (pcp/2 instrumentMode).
 *
 * settingsSha256 = sha256 of the canonical JSON of the effective request
 * settings, an object with exactly these keys:
 *   model, temperature, seed, reasoning, max_tokens,
 *   response_format_sha256, system_prompt_sha256
 * Missing values are null. Canonical JSON sorts object keys by code point and
 * has no whitespace; numbers are written as JSON.stringify writes them (an
 * integral float such as 0.0 is written 0).
 *
 * serverFingerprint = the upstream system_fingerprint when it sends one, else
 * "<served model>@<16 hex>" where the hex is the start of the sha256 of the
 * canonical JSON of the server identity headers present in the response
 * (server, via, x-powered-by, openai-version). It is never empty.
 */

export const SERVER_IDENTITY_HEADERS = ["server", "via", "x-powered-by", "openai-version"] as const;

export type EffectiveSettings = {
  model: string | null;
  temperature: number | null;
  seed: number | null;
  reasoning: unknown;
  max_tokens: number | null;
  response_format_sha256: string | null;
  system_prompt_sha256: string | null;
};

export function sha256Hex(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Canonical JSON: object keys sorted by code point, no whitespace, undefined members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => entry === undefined ? "null" : canonicalJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

function contentText(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const block = object(part);
    return typeof block?.text === "string" ? [block.text] : [];
  });
}

/** The system prompt of a model request (Responses, Messages or Chat Completions shape), or null. */
export function systemPromptText(payload: Record<string, unknown>): string | null {
  const parts: string[] = [];
  if (typeof payload.instructions === "string") parts.push(payload.instructions);
  parts.push(...contentText(payload.system));
  for (const key of ["input", "messages"] as const) {
    const items = payload[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const message = object(item);
      if (message?.role === "system" || message?.role === "developer") parts.push(...contentText(message.content));
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

export function effectiveSettings(payload: Record<string, unknown>): EffectiveSettings {
  const text = object(payload.text);
  const format = text?.format ?? payload.response_format ?? null;
  const system = systemPromptText(payload);
  return {
    model: typeof payload.model === "string" ? payload.model : null,
    temperature: finite(payload.temperature),
    seed: finite(payload.seed),
    reasoning: payload.reasoning ?? payload.thinking ?? payload.reasoning_effort ?? null,
    max_tokens: finite(payload.max_output_tokens) ?? finite(payload.max_tokens) ?? finite(payload.max_completion_tokens),
    response_format_sha256: format == null ? null : sha256Hex(canonicalJson(format)),
    system_prompt_sha256: system == null ? null : sha256Hex(system)
  };
}

export function settingsSha256(settings: EffectiveSettings): string {
  return sha256Hex(canonicalJson(settings));
}

/** settingsSha256 of a raw request body; falls back to the digest of the body when it is not a JSON object. */
export function requestSettingsSha256(body: Buffer | string): string {
  try {
    const parsed = object(JSON.parse(typeof body === "string" ? body : body.toString()));
    if (parsed) return settingsSha256(effectiveSettings(parsed));
  } catch {
    // Not JSON: still never empty.
  }
  return settingsSha256({ ...effectiveSettings({}), system_prompt_sha256: sha256Hex(body) });
}

const SAFE_FINGERPRINT = /^[\x21-\x7e]{1,200}$/u;

export function systemFingerprintOf(payload: unknown): string | undefined {
  const root = object(payload);
  const candidates = [root?.system_fingerprint, object(root?.response)?.system_fingerprint];
  for (const candidate of candidates) if (typeof candidate === "string" && SAFE_FINGERPRINT.test(candidate)) return candidate;
  return undefined;
}

type HeaderSource = { get(name: string): string | null } | Record<string, string | string[] | undefined> | null | undefined;

function header(headers: HeaderSource, name: string): string | undefined {
  if (headers == null) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  const value = (headers as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

export function serverFingerprint(input: { payload?: unknown; systemFingerprint?: string | undefined; model: string | null | undefined; headers?: HeaderSource }): string {
  const explicit = input.systemFingerprint ?? systemFingerprintOf(input.payload);
  if (explicit) return explicit;
  const identity: Record<string, string> = {};
  for (const name of SERVER_IDENTITY_HEADERS) {
    const value = header(input.headers, name);
    if (value != null && value !== "") identity[name] = value;
  }
  const model = typeof input.model === "string" && input.model.length > 0 ? input.model : "unknown";
  return `${model}@${sha256Hex(canonicalJson(identity)).slice(0, 16)}`;
}

/** Normalized finish reason: stop, length, content_filter, tool_calls, or a bounded provider value. */
export function finishReasonOf(payload: unknown): string | null {
  const root = object(payload);
  if (!root) return null;
  const choice = Array.isArray(root.choices) ? object(root.choices[0]) : null;
  const raw = typeof choice?.finish_reason === "string" ? choice.finish_reason
    : typeof root.stop_reason === "string" ? root.stop_reason
      : root.status === "incomplete" ? String(object(root.incomplete_details)?.reason ?? "incomplete")
        : root.status === "completed" ? "stop" : null;
  if (raw == null) return null;
  const normalized = ({ max_output_tokens: "length", max_tokens: "length", end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls" } as Record<string, string>)[raw] ?? raw;
  return /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/u.test(normalized) ? normalized : null;
}
