import { describe, expect, it } from "vitest";
import { responseOutputText } from "../src/advanced/responses-output.js";

describe("bulk Responses answer extraction", () => {
  it("keeps the provider's explicit output_text without duplicating nested messages", () => {
    expect(responseOutputText({ output_text: "answer", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }] })).toBe("answer");
    expect(responseOutputText({ output_text: "" })).toBe("");
  });

  it("joins only assistant output_text blocks in order, never reasoning or tool text", () => {
    expect(responseOutputText({ output: [
      { type: "reasoning", content: [{ type: "reasoning_text", text: "internal reasoning" }, { type: "output_text", text: '{"wrong":true}' }] },
      { type: "message", role: "user", content: [{ type: "output_text", text: "untrusted input" }] },
      { type: "function_call_output", content: [{ type: "output_text", text: "tool result" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"verdict":' }, { type: "refusal", text: "refused", refusal: "refused" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "true}" }, { type: "text", text: "not an answer block" }] },
    ] })).toBe('{"verdict":true}');
  });

  it.each([null, [], {}, { output: {} }, { output: [null, { type: "message", role: "assistant", content: [null, { type: "output_text", text: {} }] }] },
    { output: [{ type: "reasoning", content: [{ type: "output_text", text: '{"verdict":true}' }] }, { type: "message", role: "assistant", content: [{ type: "refusal", refusal: "refused", text: "refused" }] }] },
  ])("does not accept missing, malformed, reasoning-only or refusal-only responses as answers (%j)", (payload) => {
    expect(responseOutputText(payload)).toBe("");
  });
});
