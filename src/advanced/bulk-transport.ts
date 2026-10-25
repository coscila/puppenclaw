import { Agent, fetch as fetchWithDispatcher, type RequestInit } from "undici";

import type { ModelProviderConfig } from "../shared/types.js";

export const DEFAULT_BULK_RESPONSE_TIMEOUT_MS = 30 * 60_000;
const MAX_BULK_RESPONSE_TIMEOUT_MS = 24 * 60 * 60_000;

export function bulkResponseTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env.PUPPENCLAW_BULK_RESPONSE_TIMEOUT_MS;
  if (configured === undefined) return DEFAULT_BULK_RESPONSE_TIMEOUT_MS;
  const value = Number(configured);
  if (!/^\d+$/u.test(configured) || !Number.isSafeInteger(value) ||
      value <= 0 || value > MAX_BULK_RESPONSE_TIMEOUT_MS) {
    throw new Error("PUPPENCLAW_BULK_RESPONSE_TIMEOUT_MS must be a positive integer no greater than 86400000.");
  }
  return value;
}

class BulkResponseTimeoutError extends Error {
  readonly code = "BULK_RESPONSE_TIMEOUT";
  constructor(timeoutMs: number) {
    super(`Bulk provider response exceeded its ${timeoutMs} ms deadline.`);
    this.name = "BulkResponseTimeoutError";
  }
}

/** One deadline covers delayed headers and the complete response body. */
export class BulkRequestScope {
  readonly signal: AbortSignal;
  private readonly timeout = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(private readonly dispatcher: Agent, parent: AbortSignal, timeoutMs: number) {
    this.signal = AbortSignal.any([parent, this.timeout.signal]);
    this.timer = setTimeout(() => this.timeout.abort(new BulkResponseTimeoutError(timeoutMs)), timeoutMs);
    this.timer.unref();
  }

  fetch(url: URL, init: Omit<RequestInit, "dispatcher" | "signal">) {
    return fetchWithDispatcher(url, { ...init, dispatcher: this.dispatcher, signal: this.signal });
  }

  get timeoutError(): Error & { code: string } | undefined {
    return this.timeout.signal.aborted && this.signal.reason === this.timeout.signal.reason
      ? this.timeout.signal.reason as BulkResponseTimeoutError : undefined;
  }

  close(): void { clearTimeout(this.timer); }
}

const normalizeBase = (value: string): string => value.replace(/\/+$/u, "");

/**
 * Operator mapping from a registered provider base URL (typically a local
 * compatibility proxy) to the upstream behind it, for tool-free bulk calls:
 * PUPPENCLAW_BULK_DIRECT_UPSTREAMS='{"http://127.0.0.1:18160/v1":"http://upstream:18000/v1"}'.
 * Agents keep using the registered URL.
 */
export function directUpstreamsFromEnvironment(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const raw = env.PUPPENCLAW_BULK_DIRECT_UPSTREAMS;
  const routes = new Map<string, string>();
  if (raw === undefined || raw.trim() === "") return routes;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("PUPPENCLAW_BULK_DIRECT_UPSTREAMS must be a JSON object."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PUPPENCLAW_BULK_DIRECT_UPSTREAMS must be a JSON object.");
  for (const [registered, direct] of Object.entries(parsed)) {
    if (typeof direct !== "string") throw new Error("PUPPENCLAW_BULK_DIRECT_UPSTREAMS values must be URLs.");
    for (const value of [registered, direct]) {
      let url: URL;
      try { url = new URL(value); } catch { throw new Error(`PUPPENCLAW_BULK_DIRECT_UPSTREAMS has an invalid URL: ${value}`); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error("PUPPENCLAW_BULK_DIRECT_UPSTREAMS URLs must be http(s) without credentials, query or fragment.");
      }
    }
    routes.set(normalizeBase(registered), normalizeBase(direct));
  }
  return routes;
}

export type BulkRoute = {
  /** The provider configuration to address: the registered one, or a copy pointing at the direct upstream. */
  provider: ModelProviderConfig;
  dispatcher: Agent;
  direct: boolean;
};

/**
 * Bulk inference is non-streaming and can legitimately spend minutes before
 * headers. Calls to a mapped upstream share one keep-alive pool per upstream
 * origin and capacity group, sized to the group's concurrency limit, instead of
 * a new connection per request through the namespace proxy.
 */
export class BulkResponseTransport {
  private readonly dispatcher: Agent;
  private readonly pools = new Map<string, Agent>();
  constructor(readonly timeoutMs: number = bulkResponseTimeout(), private readonly direct: Map<string, string> = directUpstreamsFromEnvironment()) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_BULK_RESPONSE_TIMEOUT_MS) {
      throw new Error("Bulk response timeout must be a positive integer no greater than 86400000.");
    }
    this.dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  }

  /** Where a bulk call of this provider goes. `poolKey` names its capacity group; `connections` is that group's limit. */
  route(provider: ModelProviderConfig, poolKey: string, connections: number): BulkRoute {
    const direct = provider.baseUrl ? this.direct.get(normalizeBase(provider.baseUrl)) : undefined;
    if (direct === undefined) return { provider, dispatcher: this.dispatcher, direct: false };
    const key = JSON.stringify([new URL(direct).origin, poolKey]);
    let pool = this.pools.get(key);
    if (!pool) {
      pool = new Agent({
        connections: Math.max(1, Math.min(connections, 4_096)),
        pipelining: 1,
        keepAliveTimeout: 60_000,
        keepAliveMaxTimeout: 10 * 60_000,
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs
      });
      this.pools.set(key, pool);
    }
    return { provider: { ...provider, baseUrl: direct }, dispatcher: pool, direct: true };
  }

  /** Upstreams reached directly; sandboxes must not reach them either. */
  directTargets(): string[] { return [...this.direct.values()]; }

  // Acquire provider capacity before starting this scope: queue time is not inference time.
  start(parent: AbortSignal, dispatcher: Agent = this.dispatcher): BulkRequestScope { return new BulkRequestScope(dispatcher, parent, this.timeoutMs); }
  async close(): Promise<void> { await Promise.all([this.dispatcher.destroy(), ...[...this.pools.values()].map((pool) => pool.destroy())]); }
}

// ------------------------------------------------------------------------------------------
// Request shaping of the local namespace proxy for tool-free Responses calls. A direct call
// must reach the upstream exactly as the proxy would have forwarded it, so this mirrors
// rewrite_request() of the proxy for every rule that applies without tools: the turn-policy
// markers (trusted ones only from `instructions`; a user marker can only reduce tools), the
// agent_message conversion, the repair of truncated replayed function-call arguments and the
// four-image limit. Tool namespace and custom-tool rewrites need advertised tools and cannot
// apply to bulk calls, which carry none. The model name and all other fields pass unchanged.
// ------------------------------------------------------------------------------------------

const TRUSTED_MARKER_ACTIONS: Record<string, "allow" | "strip" | "require"> = {
  OCSL_TRUSTED_TURN_POLICY_DEFAULT: "allow",
  OCSL_TRUSTED_TURN_POLICY_PLAN_NO_TOOLS: "strip",
  OCSL_TRUSTED_TURN_POLICY_PLAN_READ_TOOLS: "require",
  OCSL_TRUSTED_TURN_POLICY_EXECUTION_TOOLS_ALLOWED: "require",
  OCSL_TRUSTED_TURN_POLICY_DENY_ALL_NO_TOOLS: "strip"
};
const USER_MARKER_ACTIONS: Record<string, "allow" | "strip"> = {
  OCSL_INITIAL_PLAN_NO_TOOLS: "strip",
  OCSL_STATUS_NO_TOOLS: "strip",
  OCSL_PLAN_FEEDBACK_TURN_NO_TOOLS: "strip",
  OCSL_EXECUTION_TURN_TOOLS_ALLOWED: "allow"
};
const MAX_PROMPT_IMAGES = 4;
export const IMAGE_OMISSION_TEXT = "[Older image payload omitted by codex_qwen: Titan Qwen accepts at most four images in one request. The four newest images were retained. Re-open the local source with view_image in a later batch if this image is needed.]";

export class TurnPolicyViolation extends Error {
  readonly code = "TURN_POLICY_VIOLATION";
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const firstLine = (text: unknown): string | null => typeof text === "string" && text ? text.split("\n", 1)[0]!.trim() : null;

function policyMessageText(item: Json): string | null {
  const content = item.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) for (const block of content) if (isObject(block) && typeof block.text === "string") return block.text;
  return null;
}

function latestUserMarker(payload: Json): string | null {
  const items = payload.input;
  if (!Array.isArray(items)) return null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!isObject(item)) continue;
    if (item.type !== undefined && item.type !== null && item.type !== "message") continue;
    if (item.role !== "user") continue;
    const line = firstLine(policyMessageText(item));
    return line !== null && line in USER_MARKER_ACTIONS ? line : null;
  }
  return null;
}

function advertisesTools(payload: Json): boolean { return Array.isArray(payload.tools) && payload.tools.length > 0; }
function stripTools(payload: Json): void { delete payload.tools; delete payload.parallel_tool_calls; payload.tool_choice = "none"; }

function enforceTurnPolicy(payload: Json): boolean {
  const trusted = firstLine(payload.instructions);
  const actions = new Set(trusted !== null && trusted in TRUSTED_MARKER_ACTIONS ? [TRUSTED_MARKER_ACTIONS[trusted]] : []);
  if (actions.has("strip") && actions.has("require")) throw new TurnPolicyViolation("conflicting OCSL trusted turn-policy markers in one request");
  const marker = latestUserMarker(payload);
  const userStrips = marker !== null && USER_MARKER_ACTIONS[marker] === "strip";
  if (actions.has("strip") || (userStrips && !actions.has("require"))) {
    if (advertisesTools(payload) || payload.tool_choice !== "none") { stripTools(payload); return true; }
    return false;
  }
  if (userStrips && actions.has("require")) { stripTools(payload); return true; }
  if (actions.has("require") && !advertisesTools(payload)) throw new TurnPolicyViolation("OC Science Lab tool-enabled request did not advertise callable tools.");
  return false;
}

function agentMessageAsInput(item: Json): Json {
  const parts: string[] = [];
  const content = item.content;
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isObject(block)) continue;
      const text = ["input_text", "output_text", "text"].includes(String(block.type)) ? block.text
        : block.type === "encrypted_content" ? block.encrypted_content : undefined;
      if (typeof text === "string" && text) parts.push(text);
    }
  }
  if (parts.length === 0) parts.push(`Agent message from ${String(item.author ?? "another agent")} to ${String(item.recipient ?? "this agent")}.`);
  return { type: "message", role: "user", content: [{ type: "input_text", text: parts.join("\n") }] };
}

function repairTruncatedObject(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { if (isObject(JSON.parse(value))) return value; } catch { /* repair below */ }
  const stack: string[] = [];
  let inString = false, escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") inString = true;
    else if (character === "{") stack.push("}");
    else if (character === "[") stack.push("]");
    else if (character === "}" || character === "]") { if (stack.length === 0 || stack.pop() !== character) return null; }
  }
  if (inString || stack.length === 0) return null;
  const repaired = value + stack.reverse().join("");
  try { return isObject(JSON.parse(repaired)) ? repaired : null; } catch { return null; }
}

function repairReplayedCalls(value: unknown): boolean {
  let changed = false;
  if (Array.isArray(value)) { for (const item of value) changed = repairReplayedCalls(item) || changed; return changed; }
  if (!isObject(value)) return false;
  if (value.type === "function_call") {
    const repaired = repairTruncatedObject(value.arguments);
    if (repaired !== null && repaired !== value.arguments) { value.arguments = repaired; changed = true; }
  }
  for (const child of Object.values(value)) changed = repairReplayedCalls(child) || changed;
  return changed;
}

function countImages(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countImages(item), 0);
  if (!isObject(value)) return 0;
  if (value.type === "input_image") return 1;
  return Object.values(value).reduce<number>((sum, child) => sum + countImages(child), 0);
}

function limitImages(value: unknown): boolean {
  let remaining = Math.max(0, countImages(value) - MAX_PROMPT_IMAGES);
  if (remaining === 0) return false;
  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) { for (let index = 0; index < node.length; index += 1) node[index] = rewrite(node[index]); return node; }
    if (!isObject(node)) return node;
    if (node.type === "input_image" && remaining > 0) { remaining -= 1; return { type: "input_text", text: IMAGE_OMISSION_TEXT }; }
    for (const [key, child] of Object.entries(node)) node[key] = rewrite(child);
    return node;
  };
  rewrite(value);
  return true;
}

/** Applies the proxy's tool-free request rewrites in place; true when the payload changed. */
export function shapeLikeNamespaceProxy(payload: Json): boolean {
  let changed = enforceTurnPolicy(payload);
  const input = payload.input;
  if (Array.isArray(input)) {
    for (let index = 0; index < input.length; index += 1) {
      const item = input[index];
      if (isObject(item) && item.type === "agent_message") { input[index] = agentMessageAsInput(item); changed = true; }
    }
  }
  changed = repairReplayedCalls(payload.input) || changed;
  changed = limitImages(payload.input) || changed;
  return changed;
}
