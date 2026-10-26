import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../../src/advanced/fingerprint.js";
import {
  INSTRUMENT_MESSAGE_MISMATCH,
  installedSettingsSha256,
  instrumentBundleZod,
  instrumentCall,
  instrumentMaxTokens,
  instrumentMessageMode,
  instrumentSystemPrompt,
  storedInstrumentBundle,
  storedMessageMode,
  verbatimInstrumentCall,
  type InstrumentBundle
} from "../../src/advanced/instruments.js";

const bundle: InstrumentBundle = {
  instrumentId: "citation-census@1", version: 1, systemPrompt: "Judge.", responseSchema: null,
  maxOutputTokens: { perItem: 700, minimum: 3000 }, temperature: 0, seed: null, reasoning: "none", itemsPerCall: 40, requiredModelFingerprint: null
};

describe("instrument bundles", () => {
  it("accepts exactly the contract fields", () => {
    expect(instrumentBundleZod.parse(bundle)).toEqual(bundle);
    expect(instrumentBundleZod.parse({ ...bundle, version: "1.2", seed: 7, reasoning: "low", requiredModelFingerprint: "fp" })).toMatchObject({ version: "1.2", seed: 7 });
    for (const invalid of [{ ...bundle, extra: true }, { ...bundle, reasoning: "loud" }, { ...bundle, itemsPerCall: 0 }, { ...bundle, maxOutputTokens: { perItem: 1 } }, { ...bundle, temperature: 3 }, { ...bundle, systemPrompt: "" }]) {
      expect(instrumentBundleZod.safeParse(invalid).success).toBe(false);
    }
  });

  it("budgets max(minimum, perItem × items) per call and lets an item carry only its messages and item count", () => {
    expect([1, 4, 5, 40].map((items) => instrumentMaxTokens(bundle, items))).toEqual([3000, 3000, 3500, 28000]);
    expect(instrumentCall(bundle, "one entry")).toEqual({ messages: [{ role: "user", content: "one entry" }], itemCount: 1 });
    expect(instrumentCall(bundle, { messages: [{ role: "user", content: "x" }] })).toMatchObject({ itemCount: 40 });
    expect(instrumentCall(bundle, { messages: [{ role: "user", content: [{ type: "input_text", text: "x" }] }, { role: "assistant", content: "y" }], itemCount: 3 })).toMatchObject({ itemCount: 3 });
    for (const input of [{ messages: [] }, { messages: [{ role: "system", content: "x" }] }, { messages: [{ role: "user", content: "x" }], temperature: 1 }, { messages: [{ role: "user", content: "x" }], itemCount: 41 }, 7, ""]) {
      expect(() => instrumentCall(bundle, input)).toThrow();
    }
  });

  it("digests the installed settings deterministically, independent of key order", () => {
    const digest = installedSettingsSha256("POLICY", bundle);
    expect(digest).toBe(sha256Hex(canonicalJson({ system_prompt_sha256: sha256Hex(instrumentSystemPrompt("POLICY", bundle)), response_schema_sha256: null, temperature: 0, seed: null, reasoning: "none", max_tokens: { perItem: 700, minimum: 3000 }, items_per_call: 40, required_model_fingerprint: null })));
    expect(installedSettingsSha256("POLICY", { ...bundle, responseSchema: { b: 1, a: 2 } })).toBe(installedSettingsSha256("POLICY", { ...bundle, responseSchema: { a: 2, b: 1 } }));
    expect(installedSettingsSha256("POLICY", { ...bundle, temperature: 0.1 })).not.toBe(digest);
    expect(instrumentSystemPrompt("POLICY", bundle)).toBe("POLICY\n\nJudge.");
  });
});

describe("instrument transport modes", () => {
  const verbatim: InstrumentBundle = { ...bundle, transport: { messages: "verbatim" } };

  it("adds transport.messages as an optional field: absent means policy-wrapped, anything else is refused", () => {
    expect(instrumentBundleZod.parse(verbatim)).toEqual(verbatim);
    expect(instrumentBundleZod.parse({ ...bundle, transport: { messages: "policy-wrapped" } }).transport).toEqual({ messages: "policy-wrapped" });
    // A bundle without the field parses unchanged, without a materialized default.
    expect(Object.hasOwn(instrumentBundleZod.parse(bundle), "transport")).toBe(false);
    for (const transport of [{ messages: "raw" }, { messages: "verbatim", sentBytesRecorded: true }, {}, "verbatim", null]) {
      expect(instrumentBundleZod.safeParse({ ...bundle, transport }).success, JSON.stringify(transport)).toBe(false);
    }
    expect(instrumentMessageMode(bundle)).toBe("policy-wrapped");
    expect(instrumentMessageMode(verbatim)).toBe("verbatim");
  });

  it("stores a policy-wrapped bundle without transport, so the default spelled out is the same instrument, and keeps verbatim", () => {
    const explicit = storedInstrumentBundle({ ...bundle, transport: { messages: "policy-wrapped" } });
    expect(explicit).toEqual(bundle);
    expect(canonicalJson(explicit)).toBe(canonicalJson(storedInstrumentBundle(bundle)));
    expect(storedInstrumentBundle(verbatim)).toEqual(verbatim);
    expect(storedMessageMode(explicit as Record<string, unknown>)).toBe("policy-wrapped");
    expect(storedMessageMode(verbatim as Record<string, unknown>)).toBe("verbatim");
    expect(storedMessageMode({ transport: { messages: "something" } })).toBe("policy-wrapped");
  });

  it("digests a verbatim bundle over the instrument prompt alone and keeps the policy-wrapped digest unchanged", () => {
    const policyWrapped = installedSettingsSha256("POLICY", bundle);
    // Spelling the default out changes nothing: the digest before transport modes existed.
    expect(installedSettingsSha256("POLICY", { ...bundle, transport: { messages: "policy-wrapped" } })).toBe(policyWrapped);
    const digest = installedSettingsSha256("POLICY", verbatim);
    expect(digest).toBe(sha256Hex(canonicalJson({ system_prompt_sha256: sha256Hex("Judge."), response_schema_sha256: null, temperature: 0, seed: null, reasoning: "none", max_tokens: { perItem: 700, minimum: 3000 }, items_per_call: 40, required_model_fingerprint: null, messages: "verbatim" })));
    // The worker policy never reaches a verbatim call, so it does not enter its digest.
    expect(installedSettingsSha256("ANOTHER POLICY", verbatim)).toBe(digest);
    expect(digest).not.toBe(policyWrapped);
  });
});

describe("verbatim instrument calls", () => {
  const verbatim: InstrumentBundle = { ...bundle, systemPrompt: "Judge each entry.\nOne line per entry.\n", transport: { messages: "verbatim" } };
  const request = (overrides: Record<string, unknown> = {}) => ({
    model: "judge-model", messages: [{ role: "system", content: verbatim.systemPrompt }, { role: "user", content: "ITEMS (2):\n### id=1\n### id=2" }],
    max_tokens: 3000, temperature: 0, stream: false, reasoning_effort: "none", itemCount: 2, ...overrides
  });
  const refused = (input: unknown, pattern: RegExp, target: InstrumentBundle = verbatim) => {
    let error: unknown;
    try { verbatimInstrumentCall(target, input, "judge-model"); } catch (caught) { error = caught; }
    expect(error, JSON.stringify(input)).toMatchObject({ code: INSTRUMENT_MESSAGE_MISMATCH });
    expect((error as Error).message).toMatch(pattern);
  };

  it("returns the executor's request untouched, without itemCount", () => {
    const input = request({ itemCount: 40, max_tokens: 28_000 });
    const call = verbatimInstrumentCall(verbatim, input, "judge-model");
    expect(call.itemCount).toBe(40);
    const { itemCount: _itemCount, ...expected } = input;
    expect(call.request).toEqual(expected);
    // Same values, not copies: the messages go upstream exactly as submitted.
    expect(call.request.messages).toBe(input.messages);
    expect(input.itemCount).toBe(40);
    // stream may be absent; a seed may be null while the instrument sets none; assistant turns may follow the user message.
    const { stream: _stream, ...noStream } = request();
    expect(verbatimInstrumentCall(verbatim, noStream, "judge-model").request).not.toHaveProperty("stream");
    expect(verbatimInstrumentCall(verbatim, request({ seed: null }), "judge-model").request).toMatchObject({ seed: null });
    expect(() => verbatimInstrumentCall(verbatim, request({ messages: [...request().messages, { role: "assistant", content: "{" }] }), "judge-model")).not.toThrow();
  });

  it("refuses every departure from the installed bundle with INSTRUMENT_MESSAGE_MISMATCH", () => {
    const [system, user] = request().messages as { role: string; content: string }[];
    refused("one entry", /chat request object/u);
    refused([request()], /chat request object/u);
    refused(request({ messages: [{ ...system, content: `${system!.content} ` }, user] }), /system message differs from the installed instrument prompt/u);
    // Byte for byte: the same text in another Unicode normalization form is another prompt.
    const composed = { ...verbatim, systemPrompt: "\u00c9valuer chaque entr\u00e9e." };
    expect(composed.systemPrompt.normalize("NFD")).not.toBe(composed.systemPrompt);
    refused(request({ messages: [{ ...system, content: composed.systemPrompt.normalize("NFD") }, user] }), /system message differs/u, composed);
    expect(() => verbatimInstrumentCall(composed, request({ messages: [{ ...system, content: composed.systemPrompt }, user] }), "judge-model")).not.toThrow();
    refused(request({ messages: [user] }), /first message must be the instrument's system message/u);
    refused(request({ messages: [user, system] }), /first message must be the instrument's system message/u);
    refused(request({ messages: [system, user, system] }), /only the first message may be a system message/u);
    refused(request({ messages: [system, { role: "developer", content: "x" }, user] }), /role "developer"/u);
    refused(request({ messages: [system, { role: "tool", content: "x" }, user] }), /role "tool"/u);
    refused(request({ messages: [system, { role: "assistant", content: "x" }] }), /at least one user message/u);
    refused(request({ messages: [system, { ...user, name: "reviewer" }] }), /exactly role and content/u);
    refused(request({ messages: [system, { role: "user", content: [{ type: "text", text: "x" }] }] }), /content must be a string/u);
    refused(request({ messages: [] }), /non-empty array/u);
    refused(request({ messages: "x" }), /non-empty array/u);
    refused(request({ model: "other-model" }), /model "other-model" is not the worker's model "judge-model"/u);
    refused(request({ model: undefined }), /model absent/u);
    refused(request({ temperature: 0.2 }), /temperature 0.2 differs/u);
    refused(request({ temperature: "0" }), /temperature "0" differs/u);
    refused(request({ temperature: undefined }), /temperature absent differs/u);
    refused(request({ seed: 7 }), /seed 7 differs from the instrument's absent seed/u);
    refused(request(), /seed absent differs from the instrument's 7/u, { ...verbatim, seed: 7 });
    refused(request({ seed: 8 }), /seed 8 differs/u, { ...verbatim, seed: 7 });
    refused(request({ reasoning_effort: "low" }), /reasoning_effort "low" differs/u);
    refused(request({ reasoning_effort: undefined }), /reasoning_effort absent differs/u);
    refused(request({ stream: true }), /not streamed/u);
    refused(request({ itemCount: undefined }), /itemCount absent must declare/u);
    refused(request({ itemCount: 0 }), /itemCount 0/u);
    refused(request({ itemCount: 41, max_tokens: 28_700 }), /itemCount 41/u);
    refused(request({ itemCount: 2.5 }), /itemCount 2.5/u);
    refused(request({ itemCount: 40 }), /max_tokens 3000 differs from max\(3000, 700 × 40\) = 28000/u);
    refused(request({ max_tokens: undefined }), /max_tokens absent differs/u);
    refused(request({ tools: [{ type: "function", function: { name: "lookup" } }] }), /no tools \(tools\)/u);
    refused(request({ tool_choice: "none" }), /no tools \(tool_choice\)/u);
    refused(request({ functions: [], parallel_tool_calls: false }), /no tools \(functions, parallel_tool_calls\)/u);
    refused(request({ top_p: 1 }), /fields outside the instrument request: top_p/u);
    refused(request({ response_format: { type: "json_object" } }), /fields outside the instrument request: response_format/u);
    refused(request({ max_completion_tokens: 3000, n: 2 }), /max_completion_tokens, n/u);
    expect(() => verbatimInstrumentCall(verbatim, request(), "judge-model")).not.toThrow();
  });

  it("bounds the caller-supplied values and field names it echoes", () => {
    let error: Error | undefined;
    const wide = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`${"k".repeat(500)}${index}`, 1]));
    try { verbatimInstrumentCall(verbatim, request(wide), "judge-model"); } catch (caught) { error = caught as Error; }
    expect(error?.message).toMatch(/and 12 more\.$/u);
    expect(error!.message.length).toBeLessThan(1_000);
    try { verbatimInstrumentCall(verbatim, request({ model: "m".repeat(100_000) }), "judge-model"); } catch (caught) { error = caught as Error; }
    expect(error!.message.length).toBeLessThan(300);
  });

  it("names the digests of both prompts when the system message differs, never their text", () => {
    let error: Error | undefined;
    try { verbatimInstrumentCall(verbatim, request({ messages: [{ role: "system", content: "A confidential system prompt." }, { role: "user", content: "x" }] }), "judge-model"); }
    catch (caught) { error = caught as Error; }
    expect(error?.message).toContain(sha256Hex("A confidential system prompt.").slice(0, 12));
    expect(error?.message).toContain(sha256Hex(verbatim.systemPrompt).slice(0, 12));
    expect(error?.message).not.toContain("confidential");
  });
});
