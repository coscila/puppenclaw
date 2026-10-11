import type { StatisticsTokens } from "../statistics/types.js";
const object = (x: unknown): Record<string, unknown> | null => typeof x === "object" && x !== null && !Array.isArray(x) ? x as Record<string, unknown> : null;
const count = (x: unknown): number | null => typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null;
export const noUsage = (): StatisticsTokens => ({ input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, total: null, quality: "unavailable" });
/** Canonical statistics input is inclusive; cache/reasoning are subsets. Streaming counters replace prior values. */
export function readProviderUsage(raw: unknown, previous: StatisticsTokens, anthropic: boolean): StatisticsTokens {
  const o = object(raw); if (!o) return previous;
  const input = count(o.input_tokens ?? o.prompt_tokens), output = count(o.output_tokens ?? o.completion_tokens);
  const cache = count(o.cache_read_input_tokens) ?? count(object(o.input_tokens_details ?? o.prompt_tokens_details)?.cached_tokens);
  const write = count(o.cache_creation_input_tokens) ?? count(o.cache_write_input_tokens);
  const reasoning = count(object(o.output_tokens_details ?? o.completion_tokens_details)?.reasoning_tokens);
  const result = { ...previous };
  if (input !== null) {
    result.cacheRead = cache; result.cacheWrite = write;
    result.input = anthropic ? input + (cache ?? 0) + (write ?? 0) : input;
    result.reasoning = reasoning;
  }
  if (output !== null) result.output = output;
  if (reasoning !== null) result.reasoning = reasoning;
  if (result.input !== null && result.output !== null) {
    result.total = result.input + result.output;
    result.quality = "partial";
  }
  if ([result.input, result.output, result.total].some((v) => v !== null && !Number.isSafeInteger(v))) return noUsage();
  return result;
}
export class UsageParser {
  usage = noUsage(); model: string | null = null; private tail = ""; private streaming = false; private complete = false;
  constructor(private readonly anthropic: boolean) {}
  event(raw: unknown): void {
    const o = object(raw); if (!o) return;
    if (o.type === "message_stop" || o.type === "response.completed") this.complete = true;
    const message = object(o.message), response = object(o.response);
    const source = response ?? message ?? o;
    if (typeof source.model === "string") this.model = source.model;
    this.usage = readProviderUsage(source.usage, this.usage, this.anthropic);
    if (source !== o) this.usage = readProviderUsage(o.usage, this.usage, this.anthropic);
  }
  feed(text: string): void {
    this.streaming = true; this.tail += text;
    if (this.tail.length > 4 * 1024 * 1024) throw new Error("Provider stream event exceeded the bounded parser limit.");
    for (;;) {
      const match = /\r?\n\r?\n/u.exec(this.tail); if (!match) break;
      const frame = this.tail.slice(0, match.index); this.tail = this.tail.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (data === "[DONE]") { this.complete = true; continue; }
      if (!data) continue;
      try { this.event(JSON.parse(data)); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
  }
  finish(success: boolean): void { if (this.usage.input !== null && this.usage.output !== null) this.usage.quality = success && (!this.streaming || this.complete) ? "measured" : "partial"; }
}
