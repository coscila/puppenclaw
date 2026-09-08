import { describe, expect, it } from "vitest";
import { requiresFreshClaudeTranscript } from "../../src/shared/model-compatibility.js";

describe("Claude native transcript compatibility", () => {
  it.each([
    ["claude-fable-5-1", "claude-opus-5", true],
    ["claude-opus-5", "claude-fable-5-1", true],
    ["claude-fable-5", "claude-fable-5-1", true],
    ["claude-fable-5-1[1m]", "claude-fable-5-1", false],
    ["claude-fable-5-1", "claude-fable-5-1", false],
    ["opus", "claude-opus-5", false],
  ] as const)("%s to %s requires fresh history: %s", (before, after, expected) => {
    expect(requiresFreshClaudeTranscript(before, after)).toBe(expected);
  });
});
