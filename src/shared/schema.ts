import { z } from "zod";

import { REASONING_MODE_VALUES } from "./reasoning.ts";
import { Type } from "./typebox-lite.ts";

export const PACKAGE_NAME = "@puppenclaw/openclaw-plugin";
export const PLUGIN_ID = "puppenclaw";
export const PLUGIN_NAME = "Orchestrator";
export const PLUGIN_DESCRIPTION =
  "Project-aware orchestration runtime for OpenClaw, with ACP coding agents, scientific campaign workflows, and oc2oc-aware remote control.";
export const DEFAULT_ACCOUNT_ID = "default";
export const DAEMON_PORT = 18_795;
export const DEFAULT_DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
export const DEFAULT_MAX_SESSIONS = 5;
export const DEFAULT_SESSION_TTL_MINUTES = 60;
export const DEFAULT_PERMISSION_MODE = "approve-reads" as const;
export const DEFAULT_AGENT = "claude" as const;
export const DEFAULT_REMOTE_REQUIRE_BINDING = true;
export const SESSION_STORE_VERSION = 1 as const;
export const DEFAULT_STREAM_OUTPUT = true;
export const DEFAULT_MAX_CAMPAIGNS = 32;
export const DEFAULT_ARTIFACT_RETENTION_HOURS = 24 * 14;
export const DEFAULT_RESOURCE_SAMPLING_INTERVAL_MS = 30_000;
export const DEFAULT_RESOURCE_RETENTION_DAYS = 7;
export const REMOTE_CONTROL_VERBS = [
  "project",
  "worker",
  "sync",
  "campaign",
  "campaign-status",
  "artifacts",
  "artifact-read",
  "campaign-events",
  "approve",
  "cancel",
  "reassess",
  "reassess-status",
  "reassess-report",
  "site-status",
  "logs",
  "start",
  "send",
  "status",
  "stop",
  "resume",
  "suspend",
  "focus",
  "unfocus",
  "fork",
  "cost"
] as const;
export const DEFAULT_ACPX_AGENT_COMMANDS = {
  claude: "npx -y @agentclientprotocol/claude-agent-acp",
  codex: "npx @zed-industries/codex-acp"
} as const;

const nonEmptyString = z.string().trim().min(1);
const idString = nonEmptyString.regex(/^[a-zA-Z0-9._:-]+$/u);
const skillNameString = nonEmptyString.regex(/^[a-zA-Z0-9._-]+$/u);
export const turnKeyZod = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/u);
export const ownerKeyZod = z.string().trim().min(16).max(128).regex(/^[a-zA-Z0-9._:-]+$/u);

export const agentKindZod = z.enum(["claude", "codex"]);
export const backendZod = z.enum(["local", "daemon"]);
export const permissionModeZod = z.enum(["approve-reads", "approve-all", "deny-all"]);
export const interactionModeZod = z.enum(["plan", "execute"]);
export const effortLevelZod = z.enum(REASONING_MODE_VALUES);
export const projectEffortLevelZod = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
export const planningProfileZod = z.enum(["off", "quick", "deep"]);
export const responseFormatZod = z.enum(["text", "json"]);
export const exposureModeZod = z.enum(["read-only", "execute"]);
export const remoteVerbZod = z.enum(REMOTE_CONTROL_VERBS);
export const MODEL_PROVIDER_SUBAGENT_MAX_THREADS = 16;
// Pins every Codex subagent of a session to one model and reasoning effort.
// Only an OpenAI-compatible Codex provider can carry it: the Codex wrapper
// turns it into pinned agent roles, and the provider's proxy enforces it.
export const modelProviderSubagentPolicyZod = z
  .object({
    model: nonEmptyString,
    effort: effortLevelZod,
    maxConcurrentThreads: z.number().int().min(1).max(MODEL_PROVIDER_SUBAGENT_MAX_THREADS)
  })
  .strict();
export const modelProviderConfigZod = z
  .object({
    id: skillNameString,
    label: nonEmptyString.optional(),
    kind: z.enum(["claude-code", "codex-openai", "codex-openai-compatible"]).optional(),
    model: nonEmptyString,
    reasoningProfile: z.enum(["claude", "codex", "glm-5.2", "qwen-3.6", "qwen-3.8"]).optional(),
    baseUrl: nonEmptyString.optional(),
    authTokenEnv: nonEmptyString.optional(),
    wireApi: z.enum(["responses"]).optional(),
    subagents: modelProviderSubagentPolicyZod.optional()
  })
  .strict()
  .superRefine((provider, context) => {
    if (provider.subagents != null && provider.kind !== "codex-openai-compatible") {
      context.addIssue({
        code: "custom",
        path: ["subagents"],
        message: "modelProvider.subagents requires kind codex-openai-compatible."
      });
    }
  });
export const advancedOrchestrationZod = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative().safe(),
  workers: z.array(z.object({
    id: skillNameString.max(128),
    assignment: nonEmptyString.max(50_000),
    evidencePolicy: z.literal("public-literature").optional(),
    agent: agentKindZod,
    effort: effortLevelZod.optional(),
    modelProvider: modelProviderConfigZod,
  }).strict()).min(1),
}).strict().superRefine((value, context) => {
  if (new Set(value.workers.map((worker) => worker.id)).size !== value.workers.length)
    context.addIssue({ code: 'custom', path: ['workers'], message: 'Worker configuration ids must be unique.' });
  for (const [i, worker] of value.workers.entries()) {
    if ((worker.agent === 'claude') !== (worker.modelProvider.kind === 'claude-code'))
      context.addIssue({ code: 'custom', path: ['workers', i, 'agent'], message: 'Worker agent must match its model provider harness.' });
  }
});

export const orchestrationStepKindZod = z.enum([
  "judge",
  "research",
  "plan",
  "code",
  "experiment",
  "eval",
  "artifact_sync",
  "review",
  "publish",
  "handoff"
]);
export const orchestrationExecutorZod = z.enum(["acp", "command"]);
export const campaignTemplateZod = z.enum([
  "custom",
  "literature_review",
  "baseline_from_scratch",
  "ablation_campaign",
  "self_improvement_loop",
  "puppenfusion"
]);
export const campaignStateZod = z.enum([
  "draft",
  "running",
  "cancelling",
  "recovery_required",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled"
]);
export const reassessmentProviderZod = z.enum(["puppenclaw", "codex", "claude"]);
export const reassessmentStateZod = z.enum(["running", "completed", "failed"]);
export const runStateZod = z.enum([
  "pending",
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled"
]);

export const mcpServerConfigZod = z
  .object({
    command: nonEmptyString.optional(),
    args: z.array(nonEmptyString).default([]),
    env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    cwd: nonEmptyString.optional(),
    workingDirectory: nonEmptyString.optional(),
    url: nonEmptyString.optional()
  })
  .passthrough();

export const remoteControlConfigZod = z
  .object({
    mediated: z
      .object({
        enabled: z.boolean().default(true)
      })
      .strict()
      .default({ enabled: true }),
    purePipe: z
      .object({
        enabled: z.boolean().default(false),
        allowFrom: z.array(nonEmptyString).default([]),
        allowedAgents: z.array(agentKindZod).default([])
      })
      .strict()
      .default({
        enabled: false,
        allowFrom: [],
        allowedAgents: []
      }),
    requireConversationBinding: z.boolean().default(DEFAULT_REMOTE_REQUIRE_BINDING)
  })
  .strict()
  .default({
    mediated: { enabled: true },
    purePipe: {
      enabled: false,
      allowFrom: [],
      allowedAgents: []
    },
    requireConversationBinding: DEFAULT_REMOTE_REQUIRE_BINDING
  });

export const orchestrationConfigZod = z
  .object({
    enabled: z.boolean().default(true),
    maxCampaigns: z.number().int().min(1).max(500).default(DEFAULT_MAX_CAMPAIGNS),
    artifactRetentionHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 365)
      .default(DEFAULT_ARTIFACT_RETENTION_HOURS),
    allowLocalCommandExecution: z.boolean().default(true),
    defaultProjectRoot: nonEmptyString.optional(),
    gptResearcherCommand: nonEmptyString.optional(),
    fusionArbiterCommand: nonEmptyString.optional(),
    localWorker: z
      .object({
        id: idString.default("local"),
        label: nonEmptyString.default("Local Worker"),
        labels: z.array(nonEmptyString).default(["local"]),
        projectRoots: z.array(nonEmptyString).default([])
      })
      .strict()
      .default({
        id: "local",
        label: "Local Worker",
        labels: ["local"],
        projectRoots: []
      })
  })
  .strict()
  .default({
    enabled: true,
    maxCampaigns: DEFAULT_MAX_CAMPAIGNS,
    artifactRetentionHours: DEFAULT_ARTIFACT_RETENTION_HOURS,
    allowLocalCommandExecution: true,
    localWorker: {
      id: "local",
      label: "Local Worker",
      labels: ["local"],
      projectRoots: []
    }
  });

export const pluginConfigZod = z
  .object({
    backend: backendZod.default("local"),
    daemonUrl: nonEmptyString.default(DEFAULT_DAEMON_URL),
    daemonAuthToken: z.string().optional(),
    defaultAgent: agentKindZod.default(DEFAULT_AGENT),
    maxSessions: z.number().int().positive().safe().default(DEFAULT_MAX_SESSIONS),
    permissionMode: permissionModeZod.default(DEFAULT_PERMISSION_MODE),
    sessionTtlMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(DEFAULT_SESSION_TTL_MINUTES),
    streamOutput: z.boolean().default(DEFAULT_STREAM_OUTPUT),
    resourceSamplingIntervalMs: z
      .number()
      .int()
      .min(5_000)
      .max(600_000)
      .default(DEFAULT_RESOURCE_SAMPLING_INTERVAL_MS),
    resourceRetentionDays: z
      .number()
      .int()
      .min(1)
      .max(90)
      .default(DEFAULT_RESOURCE_RETENTION_DAYS),
    acpxCommand: nonEmptyString.optional(),
    codexCommand: nonEmptyString.optional(),
    skillRoots: z.array(nonEmptyString).default([]),
    agentCommands: z
      .object({
        claude: nonEmptyString.optional(),
        codex: nonEmptyString.optional()
      })
      .strict()
      .default({}),
    mcpServers: z.record(z.string(), mcpServerConfigZod).default({}),
    fallbackTarget: nonEmptyString.optional(),
    remoteControl: remoteControlConfigZod,
    orchestration: orchestrationConfigZod
  })
  .strict();

export const workerManifestZod = z
  .object({
    id: idString,
    label: nonEmptyString,
    format: responseFormatZod.optional(),
    labels: z.array(nonEmptyString).default([]),
    projectRoots: z.array(nonEmptyString).default([]),
    supportedSteps: z
      .array(orchestrationStepKindZod)
      .default([
        "judge",
        "research",
        "plan",
        "code",
        "experiment",
        "eval",
        "review",
        "publish",
        "handoff"
      ]),
    executors: z.array(orchestrationExecutorZod).default(["acp"]),
    defaultAgent: agentKindZod.optional(),
    maxConcurrentRuns: z.number().int().min(1).max(64).default(1),
    adminOnlyRawSessions: z.boolean().default(true)
  })
  .strict();

export const projectCreateParamsZod = z
  .object({
    id: idString.optional(),
    name: nonEmptyString,
    rootDir: nonEmptyString,
    description: z.string().trim().optional(),
    defaultAgent: agentKindZod.optional(),
    fusionPreferredAgent: agentKindZod.optional(),
    planningProfile: planningProfileZod.optional(),
    permissionMode: permissionModeZod.optional(),
    effort: projectEffortLevelZod.optional(),
    model: nonEmptyString.optional(),
    format: responseFormatZod.optional()
  })
  .strict();

export const contextSyncParamsZod = z
  .object({
    projectId: idString,
    includeFiles: z.array(nonEmptyString).default([]),
    memoryText: z.string().trim().optional(),
    notes: z.string().trim().optional(),
    format: responseFormatZod.optional()
  })
  .strict();

export const campaignStepParamsZod = z
  .object({
    id: idString.optional(),
    title: nonEmptyString,
    kind: orchestrationStepKindZod,
    executor: orchestrationExecutorZod,
    instruction: z.string().trim().optional(),
    command: z.string().trim().optional(),
    contextFiles: z.array(nonEmptyString).default([]),
    approvalRequired: z.boolean().default(false),
    agent: agentKindZod.optional(),
    phaseGroup: nonEmptyString.optional(),
    sessionScope: z.enum(["campaign", "step"]).optional(),
    workingDirectory: nonEmptyString.optional(),
    env: z.record(z.string(), z.string()).default({}),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60 * 1000)
      .optional(),
    retryLimit: z.number().int().min(0).max(8).default(0)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.executor === "acp" && (value.instruction?.trim().length ?? 0) === 0) {
      ctx.addIssue({
        code: "custom",
        message: "ACP orchestration steps require instruction text.",
        path: ["instruction"]
      });
    }
    if (value.executor === "command" && (value.command?.trim().length ?? 0) === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Command orchestration steps require a command string.",
        path: ["command"]
      });
    }
  });

export const campaignRunParamsZod = z
  .object({
    projectId: idString,
    workerId: idString,
    name: nonEmptyString,
    format: responseFormatZod.optional(),
    template: campaignTemplateZod.default("custom"),
    task: nonEmptyString.optional(),
    fusionPreferredAgent: agentKindZod.optional(),
    useExternalArbiter: z.boolean().optional(),
    fusionBaseRef: nonEmptyString.optional(),
    evaluationCommand: z.string().trim().optional(),
    experimentCommands: z.array(nonEmptyString).default([]),
    experimentParallelism: z.number().int().min(1).max(16).default(1),
    iterations: z.number().int().min(1).max(10).default(1),
    steps: z.array(campaignStepParamsZod).default([])
  })
  .strict();

export const campaignStatusParamsZod = z
  .object({
    campaignId: idString.optional(),
    projectId: idString.optional(),
    format: responseFormatZod.optional()
  })
  .strict()
  .default({});

export const artifactListParamsZod = z
  .object({
    campaignId: idString.optional(),
    projectId: idString.optional(),
    format: responseFormatZod.optional()
  })
  .strict()
  .default({});

export const artifactReadParamsZod = z
  .object({
    artifactId: idString,
    limitChars: z.number().int().min(128).max(500_000).default(120_000),
    format: responseFormatZod.optional()
  })
  .strict();

export const campaignEventsParamsZod = z
  .object({
    campaignId: idString,
    after: nonEmptyString.optional(),
    limit: z.number().int().min(1).max(500).default(100),
    format: responseFormatZod.optional()
  })
  .strict();

export const campaignActionParamsZod = z
  .object({
    campaignId: idString,
    format: responseFormatZod.optional()
  })
  .strict();

export const reassessmentStartParamsZod = z
  .object({
    projectId: idString,
    workerId: idString,
    targetModel: nonEmptyString,
    targetAgent: agentKindZod.optional(),
    providers: z.array(reassessmentProviderZod).default(["puppenclaw", "codex", "claude"]),
    validationCommand: z.string().trim().optional(),
    baseRef: nonEmptyString.optional(),
    limit: z.number().int().min(1).max(200).default(20),
    format: responseFormatZod.optional()
  })
  .strict();

export const reassessmentStatusParamsZod = z
  .object({
    reassessmentId: idString.optional(),
    projectId: idString.optional(),
    format: responseFormatZod.optional()
  })
  .strict()
  .default({});

export const reassessmentReportParamsZod = z
  .object({
    reassessmentId: idString,
    format: responseFormatZod.optional()
  })
  .strict();

export const siteStatusParamsZod = z
  .object({
    verbose: z.boolean().default(false),
    format: responseFormatZod.optional()
  })
  .strict()
  .default({ verbose: false });

export const logsParamsZod = z
  .object({
    sessionName: nonEmptyString.optional(),
    campaignId: idString.optional(),
    runId: idString.optional(),
    limitChars: z.number().int().min(128).max(200_000).default(8_000),
    follow: z.boolean().default(false),
    format: responseFormatZod.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    const populated = [value.sessionName, value.campaignId, value.runId].filter(
      (entry) => entry != null
    );
    if (populated.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Exactly one of sessionName, campaignId, or runId is required.",
        path: ["sessionName"]
      });
    }
  });

export const statisticsContextZod = z.object({
  version: z.literal(1),
  chatId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u),
  attemptId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u)
}).strict();

export const startParamsZod = z
  .object({
    agent: agentKindZod,
    name: nonEmptyString,
    directory: nonEmptyString,
    task: nonEmptyString,
    format: responseFormatZod.optional(),
    permissionMode: permissionModeZod.optional(),
    interactionMode: interactionModeZod.optional(),
    effort: effortLevelZod.optional(),
    planningProfile: planningProfileZod.optional(),
    model: nonEmptyString.optional(),
    modelProviderId: skillNameString.optional(),
    modelProvider: modelProviderConfigZod.optional(),
    ownerKey: ownerKeyZod.optional(),
    turnKey: turnKeyZod.optional(),
    statisticsContext: statisticsContextZod.optional(),
    orchestration: advancedOrchestrationZod.optional(),
    lifecycleEpoch: z.number().int().positive().safe().optional(),
    contextFiles: z.array(nonEmptyString).default([]),
    skills: z.array(skillNameString).default([])
  })
  .strict();

export const pluginStartParamsZod = startParamsZod
  .omit({
    permissionMode: true,
    interactionMode: true,
    lifecycleEpoch: true,
    ownerKey: true,
    turnKey: true,
    statisticsContext: true
  })
  .strict();

export const ownerSessionListParamsZod = z
  .object({
    ownerKey: ownerKeyZod
  })
  .strict();

export const ownerSessionCleanupParamsZod = ownerSessionListParamsZod
  .extend({
    operationKey: turnKeyZod,
    sessionNames: z.array(nonEmptyString).max(1_000).default([])
  })
  .strict();

export const sendParamsZod = z
  .object({
    name: nonEmptyString,
    message: nonEmptyString,
    format: responseFormatZod.optional(),
    stream: z.boolean().optional(),
    ultrathink: z.boolean().optional(),
    effort: effortLevelZod.optional(),
    permissionMode: permissionModeZod.optional(),
    interactionMode: interactionModeZod.optional(),
    turnKey: turnKeyZod.optional(),
    statisticsContext: statisticsContextZod.optional(),
    orchestration: advancedOrchestrationZod.optional(),
    lifecycleEpoch: z.number().int().positive().safe().optional(),
    modelProviderId: skillNameString.optional(),
    modelProvider: modelProviderConfigZod.optional(),
    contextFiles: z.array(nonEmptyString).default([])
  })
  .strict();

export const pluginSendParamsZod = sendParamsZod
  .omit({
    permissionMode: true,
    interactionMode: true,
    lifecycleEpoch: true,
    turnKey: true,
    statisticsContext: true,
    modelProviderId: true,
    modelProvider: true
  })
  .strict();

export const stopParamsZod = z
  .object({
    name: nonEmptyString,
    format: responseFormatZod.optional()
  })
  .strict();

export const quiesceParamsZod = z
  .object({
    name: nonEmptyString
  })
  .strict();

export const quiescenceReleaseParamsZod = z
  .object({
    name: nonEmptyString,
    epoch: z.number().int().positive().safe()
  })
  .strict();

export const resumeParamsZod = z
  .object({
    name: nonEmptyString,
    format: responseFormatZod.optional()
  })
  .strict();

export const suspendParamsZod = z
  .object({
    name: nonEmptyString,
    format: responseFormatZod.optional()
  })
  .strict();

export const focusParamsZod = z
  .object({
    name: nonEmptyString,
    ttlMs: z
      .number()
      .int()
      .min(5_000)
      .max(5 * 60_000)
      .optional(),
    format: responseFormatZod.optional()
  })
  .strict();

export const unfocusParamsZod = z
  .object({
    name: nonEmptyString,
    format: responseFormatZod.optional()
  })
  .strict();

export const forkParamsZod = z
  .object({
    source: nonEmptyString,
    target: nonEmptyString,
    format: responseFormatZod.optional(),
    model: nonEmptyString.optional(),
    effort: effortLevelZod.optional()
  })
  .strict();

export const statusParamsZod = z
  .object({
    name: nonEmptyString.optional(),
    format: responseFormatZod.optional()
  })
  .strict()
  .default({});

export const costParamsZod = z
  .object({
    name: nonEmptyString.optional(),
    since: nonEmptyString.optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    format: responseFormatZod.optional()
  })
  .strict()
  .default({});

export const exposeParamsZod = z
  .object({
    agents: z.array(agentKindZod).default([]),
    allowPurePipe: z.boolean().default(true),
    mode: exposureModeZod.default("execute"),
    allowedVerbs: z.array(remoteVerbZod).default([...REMOTE_CONTROL_VERBS]),
    allowedProjectRoots: z.array(nonEmptyString).default([])
  })
  .strict()
  .default({
    agents: [],
    allowPurePipe: true,
    mode: "execute",
    allowedVerbs: [...REMOTE_CONTROL_VERBS],
    allowedProjectRoots: []
  });

export const pluginManifestConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    backend: {
      type: "string",
      enum: ["local", "daemon"],
      description: "local uses acpx directly; daemon talks to a standalone HTTP daemon."
    },
    daemonUrl: {
      type: "string",
      description: "Only used when backend=daemon."
    },
    daemonAuthToken: {
      type: "string",
      description: "Optional bearer token required for daemon HTTP requests; empty = no auth."
    },
    defaultAgent: {
      type: "string",
      enum: ["claude", "codex"],
      description: "Default ACP agent alias."
    },
    maxSessions: {
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "Configured admission limit for connected persistent runtime sessions; idle sessions may be suspended and retained history is not counted."
    },
    permissionMode: {
      type: "string",
      enum: ["approve-reads", "approve-all", "deny-all"],
      description: "ACP permission policy."
    },
    sessionTtlMinutes: {
      type: "integer",
      minimum: 1,
      maximum: 1440,
      description: "Garbage-collect completed or stopped sessions after this TTL."
    },
    streamOutput: {
      type: "boolean",
      description: "Capture streamed output chunks while turns run."
    },
    resourceSamplingIntervalMs: {
      type: "integer",
      minimum: 5000,
      maximum: 600000,
      description: "Interval in milliseconds between daemon /proc resource usage samples."
    },
    resourceRetentionDays: {
      type: "integer",
      minimum: 1,
      maximum: 90,
      description: "Days of resource usage history kept in resources.sqlite before pruning."
    },
    acpxCommand: {
      type: "string",
      description: "Optional acpx binary override."
    },
    codexCommand: {
      type: "string",
      description: "Optional codex binary override."
    },
    skillRoots: {
      type: "array",
      items: {
        type: "string"
      },
      description: "Additional directories containing Claude Code skills as <skill>/SKILL.md."
    },
    agentCommands: {
      type: "object",
      additionalProperties: false,
      properties: {
        claude: {
          type: "string",
          description: "Optional raw ACP adapter command override for Claude."
        },
        codex: {
          type: "string",
          description: "Optional raw ACP adapter command override for Codex."
        }
      }
    },
    mcpServers: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          command: {
            type: "string"
          },
          args: {
            type: "array",
            items: {
              type: "string"
            }
          },
          env: {
            type: "object",
            additionalProperties: {
              type: ["string", "number", "boolean"]
            }
          },
          cwd: {
            type: "string"
          },
          workingDirectory: {
            type: "string"
          },
          url: {
            type: "string"
          }
        }
      }
    },
    fallbackTarget: {
      type: "string",
      description: "Optional async notification target description."
    },
    orchestration: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean"
        },
        maxCampaigns: {
          type: "integer",
          minimum: 1,
          maximum: 500
        },
        artifactRetentionHours: {
          type: "integer",
          minimum: 1,
          maximum: 8760
        },
        allowLocalCommandExecution: {
          type: "boolean"
        },
        defaultProjectRoot: {
          type: "string"
        },
        gptResearcherCommand: {
          type: "string"
        },
        fusionArbiterCommand: {
          type: "string"
        },
        localWorker: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string"
            },
            label: {
              type: "string"
            },
            labels: {
              type: "array",
              items: {
                type: "string"
              }
            },
            projectRoots: {
              type: "array",
              items: {
                type: "string"
              }
            }
          }
        }
      }
    },
    remoteControl: {
      type: "object",
      additionalProperties: false,
      properties: {
        mediated: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: {
              type: "boolean"
            }
          }
        },
        purePipe: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: {
              type: "boolean"
            },
            allowFrom: {
              type: "array",
              items: {
                type: "string"
              }
            },
            allowedAgents: {
              type: "array",
              items: {
                type: "string",
                enum: ["claude", "codex"]
              }
            }
          }
        },
        requireConversationBinding: {
          type: "boolean"
        }
      }
    }
  }
} as const;

const reasoningModeType = () => Type.Union(REASONING_MODE_VALUES.map((mode) => Type.Literal(mode)));

const projectReasoningModeType = () =>
  Type.Union(projectEffortLevelZod.options.map((mode) => Type.Literal(mode)));

export const toolStartSchema = Type.Object({
  agent: Type.Union([Type.Literal("claude"), Type.Literal("codex")]),
  name: Type.String({ minLength: 1 }),
  directory: Type.String({ minLength: 1 }),
  task: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])),
  effort: Type.Optional(reasoningModeType()),
  planningProfile: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("quick"), Type.Literal("deep")])
  ),
  model: Type.Optional(Type.String({ minLength: 1 })),
  modelProviderId: Type.Optional(Type.String({ minLength: 1 })),
  modelProvider: Type.Optional(
    Type.Object({
      id: Type.String({ minLength: 1 }),
      label: Type.Optional(Type.String({ minLength: 1 })),
      kind: Type.Optional(
        Type.Union([
          Type.Literal("claude-code"),
          Type.Literal("codex-openai"),
          Type.Literal("codex-openai-compatible")
        ])
      ),
      model: Type.String({ minLength: 1 }),
      reasoningProfile: Type.Optional(
        Type.Union([
          Type.Literal("claude"),
          Type.Literal("codex"),
          Type.Literal("glm-5.2"),
          Type.Literal("qwen-3.6"),
          Type.Literal("qwen-3.8")
        ])
      ),
      baseUrl: Type.Optional(Type.String({ minLength: 1 })),
      authTokenEnv: Type.Optional(Type.String({ minLength: 1 })),
      wireApi: Type.Optional(Type.Literal("responses")),
      subagents: Type.Optional(
        Type.Object({
          model: Type.String({ minLength: 1 }),
          effort: reasoningModeType(),
          maxConcurrentThreads: Type.Integer({
            minimum: 1,
            maximum: MODEL_PROVIDER_SUBAGENT_MAX_THREADS
          })
        })
      )
    })
  ),
  contextFiles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  skills: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
});

export const toolSendSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  message: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])),
  stream: Type.Optional(Type.Boolean()),
  ultrathink: Type.Optional(Type.Boolean()),
  effort: Type.Optional(reasoningModeType()),
  contextFiles: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
});

export const toolStatusSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolStopSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolResumeSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolSuspendSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolFocusSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  ttlMs: Type.Optional(Type.Integer({ minimum: 5000, maximum: 300000 })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolUnfocusSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolForkSchema = Type.Object({
  source: Type.String({ minLength: 1 }),
  target: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])),
  model: Type.Optional(Type.String({ minLength: 1 })),
  effort: Type.Optional(reasoningModeType())
});

export const toolCostSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  since: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolProjectCreateSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1 })),
  name: Type.String({ minLength: 1 }),
  rootDir: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  defaultAgent: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")])),
  fusionPreferredAgent: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")])),
  planningProfile: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("quick"), Type.Literal("deep")])
  ),
  permissionMode: Type.Optional(
    Type.Union([
      Type.Literal("approve-reads"),
      Type.Literal("approve-all"),
      Type.Literal("deny-all")
    ])
  ),
  effort: Type.Optional(projectReasoningModeType()),
  model: Type.Optional(Type.String({ minLength: 1 })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolWorkerRegisterSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])),
  labels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  projectRoots: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  supportedSteps: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("judge"),
        Type.Literal("research"),
        Type.Literal("plan"),
        Type.Literal("code"),
        Type.Literal("experiment"),
        Type.Literal("eval"),
        Type.Literal("artifact_sync"),
        Type.Literal("review"),
        Type.Literal("publish"),
        Type.Literal("handoff")
      ])
    )
  ),
  executors: Type.Optional(Type.Array(Type.Union([Type.Literal("acp"), Type.Literal("command")]))),
  defaultAgent: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")])),
  maxConcurrentRuns: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
  adminOnlyRawSessions: Type.Optional(Type.Boolean())
});

export const toolContextSyncSchema = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  includeFiles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  memoryText: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

const toolCampaignStepSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1 })),
  title: Type.String({ minLength: 1 }),
  kind: Type.Union([
    Type.Literal("judge"),
    Type.Literal("research"),
    Type.Literal("plan"),
    Type.Literal("code"),
    Type.Literal("experiment"),
    Type.Literal("eval"),
    Type.Literal("artifact_sync"),
    Type.Literal("review"),
    Type.Literal("publish"),
    Type.Literal("handoff")
  ]),
  executor: Type.Union([Type.Literal("acp"), Type.Literal("command")]),
  instruction: Type.Optional(Type.String()),
  command: Type.Optional(Type.String()),
  contextFiles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  approvalRequired: Type.Optional(Type.Boolean()),
  agent: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")])),
  phaseGroup: Type.Optional(Type.String({ minLength: 1 })),
  sessionScope: Type.Optional(Type.Union([Type.Literal("campaign"), Type.Literal("step")])),
  workingDirectory: Type.Optional(Type.String({ minLength: 1 })),
  env: Type.Optional(Type.Object({}, { additionalProperties: Type.String() })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 86400000 })),
  retryLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 }))
});

export const toolCampaignRunSchema = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  workerId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])),
  template: Type.Optional(
    Type.Union([
      Type.Literal("custom"),
      Type.Literal("literature_review"),
      Type.Literal("baseline_from_scratch"),
      Type.Literal("ablation_campaign"),
      Type.Literal("self_improvement_loop"),
      Type.Literal("puppenfusion")
    ])
  ),
  task: Type.Optional(Type.String({ minLength: 1 })),
  fusionPreferredAgent: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")])),
  useExternalArbiter: Type.Optional(Type.Boolean()),
  fusionBaseRef: Type.Optional(Type.String({ minLength: 1 })),
  evaluationCommand: Type.Optional(Type.String()),
  experimentCommands: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  experimentParallelism: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
  iterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  steps: Type.Optional(Type.Array(toolCampaignStepSchema))
});

export const toolCampaignStatusSchema = Type.Object({
  campaignId: Type.Optional(Type.String({ minLength: 1 })),
  projectId: Type.Optional(Type.String({ minLength: 1 })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolArtifactsSchema = Type.Object({
  campaignId: Type.Optional(Type.String({ minLength: 1 })),
  projectId: Type.Optional(Type.String({ minLength: 1 })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolArtifactReadSchema = Type.Object({
  artifactId: Type.String({ minLength: 1 }),
  limitChars: Type.Optional(Type.Integer({ minimum: 128, maximum: 500000 })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolCampaignEventsSchema = Type.Object({
  campaignId: Type.String({ minLength: 1 }),
  after: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolCampaignActionSchema = Type.Object({
  campaignId: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolReassessmentStartSchema = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  workerId: Type.String({ minLength: 1 }),
  targetModel: Type.String({ minLength: 1 }),
  targetAgent: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")])),
  providers: Type.Optional(
    Type.Array(
      Type.Union([Type.Literal("puppenclaw"), Type.Literal("codex"), Type.Literal("claude")])
    )
  ),
  validationCommand: Type.Optional(Type.String()),
  baseRef: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolReassessmentStatusSchema = Type.Object({
  reassessmentId: Type.Optional(Type.String({ minLength: 1 })),
  projectId: Type.Optional(Type.String({ minLength: 1 })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolReassessmentReportSchema = Type.Object({
  reassessmentId: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolSiteStatusSchema = Type.Object({
  verbose: Type.Optional(Type.Boolean()),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolLogsSchema = Type.Object({
  sessionName: Type.Optional(Type.String({ minLength: 1 })),
  campaignId: Type.Optional(Type.String({ minLength: 1 })),
  runId: Type.Optional(Type.String({ minLength: 1 })),
  limitChars: Type.Optional(Type.Integer({ minimum: 128, maximum: 200000 })),
  follow: Type.Optional(Type.Boolean()),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export function buildPluginManifest(): Record<string, unknown> {
  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: PLUGIN_DESCRIPTION,
    skills: ["./skills"],
    configSchema: pluginManifestConfigSchema
  };
}
