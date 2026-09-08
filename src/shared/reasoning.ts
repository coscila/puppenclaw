export const REASONING_MODE_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode"
] as const;

export type ReasoningMode = (typeof REASONING_MODE_VALUES)[number];
export type ReasoningProfile = "claude" | "codex" | "glm-5.2" | "qwen-3.6" | "qwen-3.8";
export type EffectiveReasoningMode = ReasoningMode;

type ReasoningSubject = {
  agent: "claude" | "codex";
  model?: string | undefined;
  modelProvider?: {
    model: string;
    reasoningProfile?: ReasoningProfile | undefined;
  } | undefined;
};

export type ReasoningResolution = {
  profile: ReasoningProfile;
  requested: ReasoningMode;
  effective: EffectiveReasoningMode;
  runtimeValue: ReasoningMode;
  warning?: string;
};

const CLAUDE_MODES = new Set<ReasoningMode>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode"
]);
const CODEX_MODES = new Set<ReasoningMode>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
]);
const GLM_52_MODES = new Set<ReasoningMode>(REASONING_MODE_VALUES);
const QWEN_36_MODES = new Set<ReasoningMode>(REASONING_MODE_VALUES);
const QWEN_38_MODES = new Set<ReasoningMode>(REASONING_MODE_VALUES);

export const REASONING_CAPABILITIES = {
  version: 1,
  field: "effort",
  profiles: [
    {
      id: "claude",
      label: "Claude Code",
      modes: [
        { id: "low", label: "Low", kind: "effort" },
        { id: "medium", label: "Medium", kind: "effort" },
        { id: "high", label: "High", kind: "effort" },
        { id: "xhigh", label: "XHigh", kind: "effort" },
        { id: "max", label: "Max", kind: "effort" },
        {
          id: "ultracode",
          label: "Ultracode",
          kind: "workflow",
          selectable: true,
          availability: "requires-workflow-adapter-v1",
          defaultAdapterSupport: "runtime-verified",
          description:
            "Claude Code xhigh reasoning with native dynamic-workflow orchestration. Requires the versioned workflow adapter; unsupported runtimes fail before a prompt is dispatched."
        }
      ],
      aliases: [{ id: "ultra", effective: "max", deprecated: true }]
    },
    {
      id: "codex",
      label: "Codex",
      modes: [
        { id: "low", label: "Low", kind: "effort" },
        { id: "medium", label: "Medium", kind: "effort" },
        { id: "high", label: "High", kind: "effort" },
        { id: "xhigh", label: "XHigh", kind: "effort" },
        { id: "max", label: "Max", kind: "effort" },
        { id: "ultra", label: "Ultra", kind: "effort" }
      ],
      aliases: []
    },
    {
      id: "qwen-3.8",
      label: "Local LLM",
      modes: [
        {
          id: "none",
          label: "Off",
          kind: "thinking",
          description: "Disable thinking."
        },
        { id: "low", label: "Low", kind: "effort" },
        {
          id: "medium",
          label: "Medium",
          kind: "effort",
          description: "The local model's default reasoning tier."
        },
        {
          id: "xhigh",
          label: "XHigh",
          kind: "effort",
          description: "The local model's deepest reasoning tier."
        }
      ],
      aliases: [
        { id: "minimal", effective: "low" },
        { id: "high", effective: "xhigh" },
        { id: "max", effective: "xhigh" },
        { id: "ultra", effective: "xhigh" },
        { id: "ultracode", effective: "xhigh" }
      ]
    },
    {
      id: "qwen-3.6",
      label: "Qwen 3.6",
      modes: [
        {
          id: "minimal",
          label: "Minimal",
          kind: "effort",
          description: "Minimal reasoning for the fastest responses."
        },
        { id: "low", label: "Low", kind: "effort" },
        { id: "medium", label: "Medium", kind: "effort" },
        { id: "high", label: "High", kind: "effort" },
        { id: "xhigh", label: "XHigh", kind: "effort" },
        {
          id: "max",
          label: "Max",
          kind: "effort",
          description: "Maximum reasoning depth supported by the Qwen server."
        }
      ],
      aliases: [
        { id: "none", effective: "minimal" },
        { id: "ultra", effective: "max" },
        { id: "ultracode", effective: "max" }
      ]
    },
    {
      id: "glm-5.2",
      label: "GLM-5.2",
      modes: [
        {
          id: "none",
          label: "Off",
          kind: "thinking",
          description: "Disable thinking."
        },
        {
          id: "high",
          label: "High",
          kind: "effort",
          description: "GLM-5.2's standard thinking depth."
        },
        {
          id: "max",
          label: "Max",
          kind: "effort",
          description: "GLM-5.2's maximum thinking depth."
        }
      ],
      aliases: [
        { id: "minimal", effective: "none" },
        { id: "low", effective: "high" },
        { id: "medium", effective: "high" },
        { id: "xhigh", effective: "max" },
        { id: "ultra", effective: "max" },
        { id: "ultracode", effective: "max" }
      ]
    }
  ]
} as const;

function looksLikeGlm52(model: string | undefined): boolean {
  if (model == null) {
    return false;
  }
  return /(?:^|[^a-z0-9])glm[_.-]?5[_.-]?2(?=$|[^a-z0-9])/iu.test(model.trim());
}

function looksLikeQwen36(model: string | undefined): boolean {
  if (model == null) {
    return false;
  }
  return /(?:^|[^a-z0-9])qwen[_.-]?3[_.-]?6(?=$|[^a-z0-9])/iu.test(model.trim());
}

function looksLikeQwen38(model: string | undefined): boolean {
  if (model == null) {
    return false;
  }
  return /(?:^|[^a-z0-9])qwen[_.-]?3[_.-]?8(?=$|[^a-z0-9])/iu.test(model.trim());
}

export function reasoningProfileFor(subject: ReasoningSubject): ReasoningProfile {
  if (subject.modelProvider?.reasoningProfile != null) {
    return subject.modelProvider.reasoningProfile;
  }
  if (looksLikeGlm52(subject.modelProvider?.model ?? subject.model)) {
    return "glm-5.2";
  }
  if (looksLikeQwen36(subject.modelProvider?.model ?? subject.model)) {
    return "qwen-3.6";
  }
  if (looksLikeQwen38(subject.modelProvider?.model ?? subject.model)) {
    return "qwen-3.8";
  }
  return subject.agent;
}

function modesForProfile(profile: ReasoningProfile): Set<ReasoningMode> {
  if (profile === "claude") {
    return CLAUDE_MODES;
  }
  if (profile === "codex") {
    return CODEX_MODES;
  }
  if (profile === "qwen-3.6") {
    return QWEN_36_MODES;
  }
  if (profile === "qwen-3.8") {
    return QWEN_38_MODES;
  }
  return GLM_52_MODES;
}

export function acceptedReasoningModes(profile: ReasoningProfile): ReasoningMode[] {
  const modes = modesForProfile(profile);
  return REASONING_MODE_VALUES.filter((mode) => modes.has(mode));
}

export function resolveReasoningMode(
  subject: ReasoningSubject,
  requested: ReasoningMode
): ReasoningResolution | null {
  const profile = reasoningProfileFor(subject);
  const accepted = modesForProfile(profile);
  if (!accepted.has(requested)) {
    return null;
  }

  if (profile === "claude" && requested === "ultracode") {
    return { profile, requested, effective: "xhigh", runtimeValue: "xhigh" };
  }

  if (profile === "claude" && requested === "ultra") {
    return {
      profile,
      requested,
      effective: "max",
      runtimeValue: "max",
      warning: 'Claude does not define an "ultra" effort level; legacy Ultra was mapped to Claude Max.'
    };
  }

  if (profile === "glm-5.2") {
    const effective =
      requested === "none" || requested === "minimal"
        ? "none"
        : requested === "low" || requested === "medium" || requested === "high"
          ? "high"
          : "max";
    return {
      profile,
      requested,
      effective,
      runtimeValue: effective === "none" ? "minimal" : effective,
      ...(requested !== effective
        ? {
            warning: `GLM-5.2 reasoning mode "${requested}" maps to its effective "${effective}" tier.`
          }
        : {})
    };
  }

  if (profile === "qwen-3.8") {
    const effective =
      requested === "none"
        ? "none"
        : requested === "minimal" || requested === "low"
          ? "low"
          : requested === "medium"
            ? "medium"
            : "xhigh";
    return {
      profile,
      requested,
      effective,
      runtimeValue: effective,
      ...(requested !== effective
        ? {
            warning: `Local LLM reasoning mode "${requested}" maps to its effective "${effective}" tier.`
          }
        : {})
    };
  }

  if (profile === "qwen-3.6") {
    const effective =
      requested === "none"
        ? "minimal"
        : requested === "ultra" || requested === "ultracode"
          ? "max"
          : requested;
    return {
      profile,
      requested,
      effective,
      runtimeValue: effective,
      ...(requested !== effective
        ? {
            warning: `Qwen 3.6 reasoning mode "${requested}" maps to its effective "${effective}" tier.`
          }
        : {})
    };
  }

  return {
    profile,
    requested,
    effective: requested,
    runtimeValue: requested
  };
}
