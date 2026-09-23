import type { z } from "zod";

import type { ReasoningProfile } from "./reasoning.js";
import type {
  agentKindZod,
  backendZod,
  campaignActionParamsZod,
  campaignRunParamsZod,
  campaignStateZod,
  campaignStatusParamsZod,
  campaignTemplateZod,
  campaignStepParamsZod,
  contextSyncParamsZod,
  costParamsZod,
  effortLevelZod,
  exposeParamsZod,
  forkParamsZod,
  mcpServerConfigZod,
  orchestrationConfigZod,
  orchestrationExecutorZod,
  orchestrationStepKindZod,
  permissionModeZod,
  interactionModeZod,
  planningProfileZod,
  pluginConfigZod,
  projectCreateParamsZod,
  reassessmentProviderZod,
  reassessmentReportParamsZod,
  reassessmentStartParamsZod,
  reassessmentStateZod,
  reassessmentStatusParamsZod,
  remoteControlConfigZod,
  resumeParamsZod,
  quiescenceReleaseParamsZod,
  quiesceParamsZod,
  focusParamsZod,
  suspendParamsZod,
  modelProviderConfigZod,
  modelProviderSubagentPolicyZod,
  ownerSessionCleanupParamsZod,
  ownerSessionListParamsZod,
  runStateZod,
  artifactListParamsZod,
  artifactReadParamsZod,
  campaignEventsParamsZod,
  exposureModeZod,
  logsParamsZod,
  remoteVerbZod,
  responseFormatZod,
  sendParamsZod,
  siteStatusParamsZod,
  startParamsZod,
  statusParamsZod,
  stopParamsZod,
  unfocusParamsZod,
  workerManifestZod
} from "./schema.js";

export type AgentKind = z.infer<typeof agentKindZod>;
export type BackendMode = z.infer<typeof backendZod>;
export type PermissionMode = z.infer<typeof permissionModeZod>;
export type InteractionMode = z.infer<typeof interactionModeZod>;
export type EffortLevel = z.infer<typeof effortLevelZod>;
export type PlanningProfile = z.infer<typeof planningProfileZod>;
export type ResponseFormat = z.infer<typeof responseFormatZod>;
export type ExposureMode = z.infer<typeof exposureModeZod>;
export type RemoteVerb = z.infer<typeof remoteVerbZod>;
export type ModelProviderConfig = z.infer<typeof modelProviderConfigZod>;
export type ModelProviderSubagentPolicy = z.infer<typeof modelProviderSubagentPolicyZod>;
export type PluginConfig = z.input<typeof pluginConfigZod>;
export type ParsedPluginConfig = z.output<typeof pluginConfigZod>;
export type McpServerConfig = z.infer<typeof mcpServerConfigZod>;
export type RemoteControlConfig = z.infer<typeof remoteControlConfigZod>;
export type OrchestrationConfig = z.infer<typeof orchestrationConfigZod>;
export type StartParams = Omit<z.infer<typeof startParamsZod>, "skills"> & {
  skills?: z.infer<typeof startParamsZod>["skills"];
};
export type OwnerSessionListParams = z.infer<typeof ownerSessionListParamsZod>;
export type OwnerSessionCleanupParams = z.infer<typeof ownerSessionCleanupParamsZod>;
export type SendParams = z.infer<typeof sendParamsZod>;
export type StopParams = z.infer<typeof stopParamsZod>;
export type QuiesceParams = z.infer<typeof quiesceParamsZod>;
export type QuiescenceReleaseParams = z.infer<typeof quiescenceReleaseParamsZod>;
export type ResumeParams = z.infer<typeof resumeParamsZod>;
export type SuspendParams = z.infer<typeof suspendParamsZod>;
export type FocusParams = z.infer<typeof focusParamsZod>;
export type UnfocusParams = z.infer<typeof unfocusParamsZod>;
export type ForkParams = z.infer<typeof forkParamsZod>;
export type StatusParams = z.infer<typeof statusParamsZod>;
export type CostParams = z.infer<typeof costParamsZod>;
export type ExposeParams = z.infer<typeof exposeParamsZod>;
export type WorkerManifestInput = z.infer<typeof workerManifestZod>;
export type ProjectCreateParams = z.infer<typeof projectCreateParamsZod>;
export type ContextSyncParams = z.infer<typeof contextSyncParamsZod>;
export type OrchestrationStepParams = z.infer<typeof campaignStepParamsZod>;
export type CampaignRunParams = z.infer<typeof campaignRunParamsZod>;
export type CampaignStatusParams = z.infer<typeof campaignStatusParamsZod>;
export type ArtifactListParams = z.infer<typeof artifactListParamsZod>;
export type ArtifactReadParams = z.infer<typeof artifactReadParamsZod>;
export type CampaignEventsParams = z.infer<typeof campaignEventsParamsZod>;
export type CampaignActionParams = z.infer<typeof campaignActionParamsZod>;
export type SiteStatusParams = z.infer<typeof siteStatusParamsZod>;
export type LogsParams = z.infer<typeof logsParamsZod>;
export type OrchestrationStepKind = z.infer<typeof orchestrationStepKindZod>;
export type OrchestrationExecutor = z.infer<typeof orchestrationExecutorZod>;
export type CampaignTemplate = z.infer<typeof campaignTemplateZod>;
export type CampaignState = z.infer<typeof campaignStateZod>;
export type ReassessmentProvider = z.infer<typeof reassessmentProviderZod>;
export type ReassessmentState = z.infer<typeof reassessmentStateZod>;
export type ReassessmentStartParams = z.infer<typeof reassessmentStartParamsZod>;
export type ReassessmentStatusParams = z.infer<typeof reassessmentStatusParamsZod>;
export type ReassessmentReportParams = z.infer<typeof reassessmentReportParamsZod>;
export type RunState = z.infer<typeof runStateZod>;

export type ToolTextBlock = {
  type: "text";
  text: string;
};

export type ToolResult<TDetails = Record<string, unknown>> = {
  content: ToolTextBlock[];
  details: TDetails;
};

export type TurnOutputRole = "assistant" | "status";

export type NativePlanEntry = {
  content: string;
  status?: string;
  priority?: string;
};

export type TurnSignals = {
  nativeMode?: string;
  plan?: {
    source: "acp" | "claude-tool";
    entries?: NativePlanEntry[];
  };
  inputRequest?: {
    source: "claude-tool";
    toolName: "AskUserQuestion";
    text?: string;
  };
  stopReason?: string;
};

export type SessionState =
  | "idle"
  | "running"
  | "waiting_input"
  | "suspended"
  | "completed"
  | "failed"
  | "stopped";

export type ActiveTurnLifecycleState =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "orphaned";

export type ActiveTurnMetadata = {
  id: string;
  turnKey?: string;
  requestFingerprint?: string;
  state: ActiveTurnLifecycleState;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  pid?: number;
  processGroupId?: number;
  processStartIdentity?: string;
  lastOutputAt?: string;
  outputChars: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  failureCode?: string;
  retryable?: boolean;
};

export type SessionRecoveryFence = {
  reason: "restart-survivor" | "unverified-process" | "missing-turn-metadata";
  detectedAt: string;
  pid?: number;
  processGroupId?: number;
  processStartIdentity?: string;
};

/**
 * Canonical four-bucket per-turn token usage, mirroring OpenClaw core's
 * NormalizedUsage. `total` is the sum of the four buckets.
 */
export type NormalizedUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type TokenUsage = {
  used?: number;
  size?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** @deprecated legacy alias of cacheRead; retained only for reading old persisted state. */
  cached?: number;
};

/**
 * One immutable per-turn usage record. Persisted in the durable usage ledger
 * (`usage.sqlite`) which survives session `purge()`/`gc()`, so historical token
 * counts remain queryable after a session or chat is deleted.
 */
export type UsageLedgerEntry = {
  id: string;
  sessionName: string;
  agent: AgentKind;
  provider: string;
  model: string;
  usage: NormalizedUsage;
  stopReason?: string;
  durationMs: number;
  timestamp: string;
  /**
   * Present when one turn is recorded as several per-model rows (Codex
   * `ocsl.model_usage`): all rows of the turn share it, so turn counts use
   * DISTINCT turnId. Legacy single-row turns omit it and count by row id.
   */
  turnId?: string;
  role?: "main" | "subagent";
  /** Native Codex threads aggregated into this row. */
  threads?: number;
};

export type SessionTranscriptEntry = {
  role: "system" | "user" | "assistant" | "status";
  text: string;
  createdAt: string;
  turnId?: string;
};

export type ContextFileEntry = {
  path: string;
  resolvedPath: string;
  bytes: number;
  truncated: boolean;
};

export type InstalledSkillReceipt = {
  name: string;
  sourcePath: string;
  targetPath: string;
};

export type TurnRequestSuccessOutcome = {
  version: 1;
  kind: "success";
  summary: string;
  session: {
    name: string;
    state: SessionState;
    lastActivity: string;
    pendingQuestion?: string;
    lastError?: string;
    failureCode?: string;
    retryable?: boolean;
    activeTurn?: ActiveTurnMetadata;
    tokenUsage?: TokenUsage;
  };
  output: string;
  outputRole: TurnOutputRole;
  failureCode?: string;
  retryable?: boolean;
  turnSignals?: TurnSignals;
  contextFiles: Array<Omit<ContextFileEntry, "resolvedPath">>;
  skills?: Array<Pick<InstalledSkillReceipt, "name">>;
};

export type TurnRequestErrorOutcome = {
  version: 1;
  kind: "error";
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, string | number | boolean | null>;
  session?: TurnRequestSuccessOutcome["session"];
};

export type TurnRequestOutcome = TurnRequestSuccessOutcome | TurnRequestErrorOutcome;

export type TurnRequestReceipt = {
  sessionName: string;
  turnKey: string;
  operation: "start" | "send";
  requestFingerprint: string;
  /**
   * Tombstones retain only request identity after the bounded replay window.
   * They deliberately fail closed instead of making an old key executable.
   */
  state: "running" | "settled" | "tombstone";
  acceptedAt: string;
  updatedAt: string;
  completedAt?: string;
  activeTurnId?: string;
  outcome?: TurnRequestOutcome;
};

export type AcpxSessionHandle = {
  runtimeSessionName: string;
  cwd: string;
  agent: AgentKind;
  mode: "persistent";
};

export type SessionInfo = {
  name: string;
  agent: AgentKind;
  directory: string;
  state: SessionState;
  createdAt: string;
  lastActivity: string;
  focusedUntil?: string;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  effectiveEffort?: EffortLevel;
  runtimeEffort?: EffortLevel;
  reasoningProfile?: ReasoningProfile;
  planningProfile?: PlanningProfile;
  model?: string;
  modelProviderId?: string;
  modelProvider?: ModelProviderConfig;
  skills?: string[];
  tokenUsage?: TokenUsage;
  pendingQuestion?: string;
  lastError?: string;
  failureCode?: string;
  retryable?: boolean;
  warnings: string[];
  transcript: SessionTranscriptEntry[];
  handle?: AcpxSessionHandle;
  lastStopReason?: string;
  activeTurn?: ActiveTurnMetadata;
  recoveryFence?: SessionRecoveryFence;
  source?: SessionSourceInfo;
  origin?: ConversationScope;
};

export type ConversationScope = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string | number;
};

export type SessionSourceInfo = {
  kind: "tool" | "command" | "daemon";
  channel?: string;
  requesterSenderId?: string;
  bindingId?: string;
};

export type SessionQuiescenceReservation = {
  name: string;
  epoch: number;
  purpose: "external" | "purge";
  updatedAt: string;
};

export type SessionQuiescenceState = {
  lastEpoch: number;
  active: Record<string, SessionQuiescenceReservation>;
  latestByName: Record<string, number>;
};

export type OwnerCleanupLifecycleState = "quiesced" | "purging" | "purged";

export type OwnerCleanupReservation = {
  epoch: number;
  operationKey: string;
  state: OwnerCleanupLifecycleState;
  updatedAt: string;
};

export type OwnerCleanupState = {
  lastEpoch: number;
  scopes: Record<string, OwnerCleanupReservation>;
};

export type ExposureRecord = {
  bindingId: string;
  conversation: ConversationScope;
  allowPurePipe: boolean;
  allowedAgents: AgentKind[];
  mode: ExposureMode;
  allowedVerbs: RemoteVerb[];
  allowedProjectRoots: string[];
  updatedAt: string;
};

export type SiteAgentAvailability = {
  agent: AgentKind;
  command: string;
  configured: boolean;
};

export type SiteSessionSnapshot = {
  name: string;
  agent: AgentKind;
  directory: string;
  state: SessionState;
  lastActivity: string;
  sourceKind?: SessionSourceInfo["kind"];
};

export type SiteCampaignSnapshot = {
  id: string;
  name: string;
  projectId: string;
  workerId: string;
  template: CampaignTemplate;
  state: CampaignState;
  currentStepIndex: number;
  experimentParallelism: number;
  lastProgressAt: string;
  lastError?: string;
};

export type SiteWorkerSnapshot = {
  id: string;
  label: string;
  labels: string[];
  projectRoots: string[];
  supportedSteps: OrchestrationStepKind[];
  executors: OrchestrationExecutor[];
  defaultAgent?: AgentKind;
  maxConcurrentRuns: number;
  activeCampaigns: number;
};

export type SiteStatus = {
  siteId: string;
  label: string;
  backend: BackendMode;
  pluginHealth: "ok";
  openclawRuntime: {
    available: boolean;
  };
  defaultAgent: AgentKind;
  availableAgents: SiteAgentAvailability[];
  orchestration: {
    enabled: boolean;
    allowLocalCommandExecution: boolean;
    defaultProjectRoot?: string;
    projectRoots: string[];
  };
  sessions: {
    maxSessions: number;
    total: number;
    active: number;
    streamOutputSupported: boolean;
    logTailingSupported: boolean;
    items?: SiteSessionSnapshot[];
  };
  campaigns: {
    maxCampaigns: number;
    total: number;
    active: number;
    items?: SiteCampaignSnapshot[];
  };
  workers: SiteWorkerSnapshot[];
  exposures: {
    total: number;
    currentExposure: ExposureRecord | null;
    items?: ExposureRecord[];
  };
};

export type LogScope = "session" | "campaign" | "run";

export type LogEntry = {
  id: string;
  title: string;
  state?: string;
  updatedAt: string;
  text: string;
};

export type LogsResult = {
  scope: LogScope;
  targetId: string;
  limitChars: number;
  followRequested: boolean;
  followSupported: boolean;
  text: string;
  entries: LogEntry[];
};

export type StoredState = {
  version: 1;
  sessions: Record<string, SessionInfo>;
  turnRequests: Record<string, Record<string, TurnRequestReceipt>>;
  turnGenerations: Record<string, number>;
  exposures: Record<string, ExposureRecord>;
  quiescence: SessionQuiescenceState;
  sessionOwners: Record<string, string>;
  ownerCleanup: OwnerCleanupState;
};

export type StateRecoveryStatus =
  | {
      required: false;
    }
  | {
      required: true;
      reason: "corrupt" | "incompatible" | "invalid" | "unreadable";
      message: string;
      detectedAt: string;
      quarantinePath?: string;
    };

export type PromptEvent =
  | {
      type: "text_delta";
      text: string;
      stream: "output" | "thought";
      tag?: string;
    }
  | {
      type: "tool_call";
      text: string;
      title: string;
      status?: string;
      tag?: string;
      toolCallId?: string;
      nativeToolName?: "ExitPlanMode" | "AskUserQuestion";
      inputRequestText?: string;
    }
  | {
      type: "plan";
      entries: NativePlanEntry[];
    }
  | {
      type: "mode";
      mode: string;
    }
  | {
      type: "status";
      text: string;
      tag?: string;
      used?: number;
      size?: number;
      usage?: NormalizedUsage;
    }
  | {
      type: "done";
      stopReason?: string;
      usage?: NormalizedUsage;
    }
  | {
      type: "error";
      message: string;
      code?: string;
      retryable?: boolean;
      detailCode?: string;
      origin?: string;
    };

export type CommandParseResult =
  | {
      ok: true;
      verb: string;
      payloadText: string;
    }
  | {
      ok: false;
      message: string;
    };
