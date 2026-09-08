import { describe, expect, it } from "vitest";

import {
  REASONING_CAPABILITIES,
  acceptedReasoningModes,
  reasoningProfileFor,
  resolveReasoningMode,
  type ReasoningMode,
  type ReasoningProfile
} from "../../src/shared/reasoning.js";

describe("reasoning profiles", () => {
  it.each([
    "glm-5.2",
    "GLM-5-2",
    "zai-org/GLM-5.2",
    "local.glm_5_2",
    "glm-5.2[1m]"
  ])("detects GLM-5.2 from model name %s", (model) => {
    expect(reasoningProfileFor({ agent: "codex", model })).toBe("glm-5.2");
  });

  it("prefers an explicit provider reasoning profile over model-name detection", () => {
    expect(
      reasoningProfileFor({
        agent: "codex",
        model: "glm-5.2",
        modelProvider: {
          model: "glm-5.2",
          reasoningProfile: "codex"
        }
      })
    ).toBe("codex");
    expect(
      reasoningProfileFor({
        agent: "claude",
        modelProvider: {
          model: "custom-relay-name",
          reasoningProfile: "glm-5.2"
        }
      })
    ).toBe("glm-5.2");
  });

  it.each([
    ["none", "none"],
    ["minimal", "none"],
    ["low", "high"],
    ["medium", "high"],
    ["high", "high"],
    ["xhigh", "max"],
    ["max", "max"],
    ["ultra", "max"],
    ["ultracode", "max"]
  ] as const)("maps GLM-5.2 %s to its effective %s tier", (requested, effective) => {
    const resolution = resolveReasoningMode(
      {
        agent: "claude",
        modelProvider: {
          model: "glm-5.2",
          reasoningProfile: "glm-5.2"
        }
      },
      requested
    );

    expect(resolution).toMatchObject({
      profile: "glm-5.2",
      requested,
      effective,
      runtimeValue: effective === "none" ? "minimal" : effective
    });
    if (requested === effective) {
      expect(resolution?.warning).toBeUndefined();
    } else {
      expect(resolution?.warning).toContain(`maps to its effective "${effective}" tier`);
    }
  });

  it("maps legacy Claude Ultra to Max with an explicit compatibility warning", () => {
    expect(resolveReasoningMode({ agent: "claude" }, "ultra")).toEqual({
      profile: "claude",
      requested: "ultra",
      effective: "max",
      runtimeValue: "max",
      warning: 'Claude does not define an "ultra" effort level; legacy Ultra was mapped to Claude Max.'
    });
  });

  it("exposes Claude Ultracode as a runtime-verified workflow capability", () => {
    expect(resolveReasoningMode({ agent: "claude" }, "ultracode")).toMatchObject({ effective: "xhigh", runtimeValue: "xhigh", requested: "ultracode" });
    const claude = REASONING_CAPABILITIES.profiles.find(
      (profile) => profile.id === "claude"
    );
    expect(claude?.modes.find((mode) => mode.id === "ultracode")).toMatchObject({
      kind: "workflow",
      selectable: true,
      availability: "requires-workflow-adapter-v1",
      defaultAdapterSupport: "runtime-verified"
    });
  });

  it.each(["none", "minimal", "ultracode"] as const)(
    "rejects unsupported Codex mode %s",
    (requested) => {
      expect(resolveReasoningMode({ agent: "codex" }, requested)).toBeNull();
      expect(acceptedReasoningModes("codex")).not.toContain(requested);
    }
  );

  it.each([
    ["claude", ["low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]],
    ["codex", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    [
      "glm-5.2",
      ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]
    ],
    [
      "qwen-3.6",
      ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]
    ],
    [
      "qwen-3.8",
      ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]
    ]
  ] satisfies Array<[ReasoningProfile, ReasoningMode[]]>) (
    "advertises only accepted %s modes",
    (profile, expected) => {
      expect(acceptedReasoningModes(profile)).toEqual(expected);
    }
  );

  it.each([
    "Qwen/Qwen3.6-27B-FP8",
    "qwen3.6",
    "QWEN-3-6",
    "local/qwen_3_6-instruct"
  ])("detects Qwen 3.6 from model name %s", (model) => {
    expect(reasoningProfileFor({ agent: "codex", model })).toBe("qwen-3.6");
  });

  it("does not detect other Qwen generations as the Qwen 3.6 profile", () => {
    expect(
      reasoningProfileFor({ agent: "codex", model: "Qwen/Qwen3-Coder-30B" })
    ).toBe("codex");
    expect(
      reasoningProfileFor({ agent: "codex", model: "qwen35-coder-composite" })
    ).toBe("codex");
  });

  it.each([
    ["none", "minimal"],
    ["minimal", "minimal"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "max"],
    ["ultra", "max"],
    ["ultracode", "max"]
  ] as const)("maps Qwen 3.6 %s to its effective %s tier", (requested, effective) => {
    const resolution = resolveReasoningMode(
      {
        agent: "codex",
        modelProvider: {
          model: "Qwen/Qwen3.6-27B-FP8",
          reasoningProfile: "qwen-3.6"
        }
      },
      requested
    );

    expect(resolution).toMatchObject({
      profile: "qwen-3.6",
      requested,
      effective,
      runtimeValue: effective
    });
    if (requested === effective) {
      expect(resolution?.warning).toBeUndefined();
    } else {
      expect(resolution?.warning).toContain(`maps to its effective "${effective}" tier`);
    }
  });

  it.each([
    "Qwen/Qwen3.8-27B-FP8",
    "qwen3.8",
    "QWEN-3-8",
    "local/qwen_3_8-instruct"
  ])("detects Qwen 3.8 from model name %s", (model) => {
    expect(reasoningProfileFor({ agent: "codex", model })).toBe("qwen-3.8");
  });

  it.each([
    ["none", "none"],
    ["minimal", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "xhigh"],
    ["xhigh", "xhigh"],
    ["max", "xhigh"],
    ["ultra", "xhigh"],
    ["ultracode", "xhigh"]
  ] as const)("maps Qwen 3.8 %s to its effective %s tier", (requested, effective) => {
    const resolution = resolveReasoningMode(
      {
        agent: "codex",
        modelProvider: {
          model: "Qwen/Qwen3.8-27B-FP8",
          reasoningProfile: "qwen-3.8"
        }
      },
      requested
    );

    expect(resolution).toMatchObject({
      profile: "qwen-3.8",
      requested,
      effective,
      runtimeValue: effective
    });
    if (requested === effective) {
      expect(resolution?.warning).toBeUndefined();
    } else {
      expect(resolution?.warning).toContain(`maps to its effective "${effective}" tier`);
    }
  });

  it("advertises the four selectable Local LLM effort modes", () => {
    const qwen = REASONING_CAPABILITIES.profiles.find(
      (profile) => profile.id === "qwen-3.8"
    );
    expect(qwen?.label).toBe("Local LLM");
    expect(qwen?.modes.map((mode) => mode.id)).toEqual(["none", "low", "medium", "xhigh"]);
    expect(qwen?.aliases.map((alias) => alias.id)).toEqual([
      "minimal",
      "high",
      "max",
      "ultra",
      "ultracode"
    ]);
  });

  it("advertises the six selectable Qwen 3.6 effort modes", () => {
    const qwen = REASONING_CAPABILITIES.profiles.find(
      (profile) => profile.id === "qwen-3.6"
    );
    expect(qwen?.modes.map((mode) => mode.id)).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]);
    expect(qwen?.aliases.map((alias) => alias.id)).toEqual([
      "none",
      "ultra",
      "ultracode"
    ]);
  });
});
