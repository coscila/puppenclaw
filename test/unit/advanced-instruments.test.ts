import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../../src/advanced/fingerprint.js";
import { installedSettingsSha256, instrumentBundleZod, instrumentCall, instrumentMaxTokens, instrumentSystemPrompt, type InstrumentBundle } from "../../src/advanced/instruments.js";

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
