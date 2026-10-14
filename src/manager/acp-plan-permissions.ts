type JsonRecord = Record<string, unknown>;
type PermissionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";
type PermissionRequest = {
  plan: boolean;
  options: Map<string, PermissionKind>;
  decision?: "allowed" | "denied";
};

const MAX_ID_CHARS = 1_024;
const MAX_PERMISSION_REQUESTS = 128;
const MAX_PERMISSION_OPTIONS = 16;
const MAX_PLAN_CHARS = 256_000;

type PlanCompletionContext = {
  exitCode: number | null;
  signal: string | null;
  interactionMode?: string | undefined;
  permissionMode: string;
  hasFreshOutput: boolean;
  hasError: boolean;
};

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord : undefined;
}

function identifier(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS) {
    return `s:${value}`;
  }
  return typeof value === "number" && Number.isSafeInteger(value) ? `n:${value}` : undefined;
}

/**
 * Evidence from one ACPX JSON stdout invocation, never persisted history.
 * ACPX 0.12.1 forwards both directions of the ACP wire, then exits 5 when
 * all requested permissions were denied, even after a successful end_turn.
 * Claude represents "No, keep planning" as switch_mode / plan / reject_once.
 * A completed plan may follow ordinary tool denials during reconnaissance.
 * Account for every decision, and require the last permission to hold a plan.
 * Exit 5 is excused only when all observed permissions were denied.
 * Only bounded plan text from the correlated permission request is retained,
 * privately, to publish the offered plan instead of an automated rejection.
 */
export class AcpPlanPermissionTracker {
  private invalid = false;
  private promptId: string | undefined;
  private sessionId: string | undefined;
  private completed = false;
  private sawAssistantOutput = false;
  private requests = new Map<string, PermissionRequest>();
  #requestPlans = new Map<string, string>();
  #offeredPlan: string | undefined;

  get deniedPlanRequests(): number {
    let count = 0;
    for (const request of this.requests.values()) {
      if (request.plan && request.decision === "denied") count += 1;
    }
    return count;
  }

  get deniedToolRequests(): number {
    let count = 0;
    for (const request of this.requests.values()) {
      if (!request.plan && request.decision === "denied") count += 1;
    }
    return count;
  }

  observeLine(line: string): void {
    if (line.trim().length === 0 || this.invalid) return;
    try {
      this.observe(JSON.parse(line) as unknown);
    } catch {
      // Unparsed stdout cannot establish that all permissions were observed.
      this.invalid = true;
    }
  }

  observe(value: unknown): void {
    if (this.invalid) return;
    const message = record(value);
    if (!message) {
      this.invalid = true;
      return;
    }
    if (Object.hasOwn(message, "error") || message.type === "error") {
      // Startup load/probe errors precede the current prompt. The caller's
      // normal error handling still owns them; they are not its permissions.
      if (this.promptId !== undefined) this.invalid = true;
      return;
    }

    const method = message.method;
    const params = record(message.params);
    const id = identifier(message.id);

    if (method === "session/prompt") {
      const sessionId = identifier(params?.sessionId);
      if (message.jsonrpc !== "2.0" || this.promptId !== undefined || id === undefined ||
          sessionId === undefined || typeof params?.sessionId !== "string") {
        this.invalid = true;
        return;
      }
      this.promptId = id;
      this.sessionId = sessionId;
      return;
    }

    if (this.promptId === undefined) {
      // ACPX's permission counters can include startup requests. Their
      // decisions must not be silently attributed to the later prompt.
      if (method === "session/request_permission" || Object.hasOwn(record(message.result) ?? {}, "outcome")) {
        this.invalid = true;
      }
      return;
    }
    if (method === "session/cancel") {
      this.invalid = true;
      return;
    }

    if (method === "session/request_permission") {
      const options = permissionOptions(params);
      const plan = isKeepPlanningRequest(params);
      if (message.jsonrpc !== "2.0" || this.promptId === undefined || this.completed ||
          id === undefined || id === this.promptId || this.requests.has(id) ||
          identifier(params?.sessionId) !== this.sessionId ||
          this.requests.size >= MAX_PERMISSION_REQUESTS || options === undefined ||
          (!plan && !isOrdinaryToolRequest(params))) {
        this.invalid = true;
        return;
      }
      this.requests.set(id, { plan, options });
      const text = plan ? permissionPlanText(params) : undefined;
      if (text !== undefined) this.#requestPlans.set(id, text);
      return;
    }

    if (method === "session/update" && this.promptId !== undefined) {
      if (identifier(params?.sessionId) !== this.sessionId) {
        this.invalid = true;
        return;
      }
      const update = record(params?.update);
      if (update?.sessionUpdate === "current_mode_update" && update.currentModeId !== "plan") {
        this.invalid = true;
      }
      if (update?.sessionUpdate === "agent_message_chunk") {
        if (this.completed) this.invalid = true;
        const content = record(update.content);
        if (content?.type === "text" && typeof content.text === "string" && content.text.trim()) {
          this.sawAssistantOutput = true;
        }
      }
      return;
    }

    const result = record(message.result);
    if (result === undefined) return;
    if (Object.hasOwn(result, "outcome")) {
      const outcome = record(result.outcome);
      const request = id === undefined ? undefined : this.requests.get(id);
      const option = typeof outcome?.optionId === "string" ? request?.options.get(outcome.optionId) : undefined;
      if (message.jsonrpc !== "2.0" || id === undefined || this.completed ||
          request === undefined || request.decision !== undefined ||
          outcome?.outcome !== "selected" || option === undefined ||
          (request.plan && outcome.optionId !== "plan")) {
        this.invalid = true;
        return;
      }
      request.decision = option === "allow_once" || option === "allow_always" ? "allowed" : "denied";
      // Use request order, not reply order, to identify the final offered plan.
      if (request.plan && id === [...this.requests.keys()].at(-1)) {
        this.#offeredPlan = this.#requestPlans.get(id);
      }
      return;
    }
    if (id !== undefined && this.requests.has(id)) {
      this.invalid = true;
      return;
    }
    if (Object.hasOwn(result, "stopReason") || (id !== undefined && id === this.promptId)) {
      if (message.jsonrpc !== "2.0" || this.promptId === undefined || id !== this.promptId ||
          this.completed || result.stopReason !== "end_turn" ||
          this.deniedPlanRequests === 0 || [...this.requests.values()].some((request) => !request.decision)) {
        this.invalid = true;
        return;
      }
      this.completed = true;
    }
  }

  allowsCompletedPlan(params: PlanCompletionContext): boolean {
    return this.isCompletedPlan(params) && params.exitCode === 5 &&
      [...this.requests.values()].every((request) => request.decision === "denied");
  }

  private isCompletedPlan(params: PlanCompletionContext): boolean {
    const requests = [...this.requests.values()];
    return !this.invalid && this.completed && this.sawAssistantOutput &&
      requests.at(-1)?.plan === true && this.deniedPlanRequests > 0 &&
      // With other permissions in the turn, require the actual offered plan;
      // final prose alone cannot establish a successful approval handoff.
      (requests.every((request) => request.plan) || this.#offeredPlan !== undefined) &&
      params.signal === null && params.interactionMode === "plan" &&
      params.permissionMode === "approve-reads" && params.hasFreshOutput && !params.hasError;
  }

  completedPlanHandoff(params: PlanCompletionContext): { text?: string; deniedToolRequests?: number } | undefined {
    // ACPX exits normally when other tools ran successfully before this
    // automatic mode-switch rejection. That is the same approval handoff,
    // but must not relax the separate nonzero-exit exception above.
    if (!this.isCompletedPlan(params) ||
        (params.exitCode !== 0 && !this.allowsCompletedPlan(params))) return undefined;
    return {
      ...(this.#offeredPlan === undefined ? {} : { text: this.#offeredPlan }),
      ...(this.deniedToolRequests > 0 ? { deniedToolRequests: this.deniedToolRequests } : {})
    };
  }
}

function permissionOptions(params: JsonRecord | undefined): Map<string, PermissionKind> | undefined {
  const options = params?.options;
  if (!Array.isArray(options) || options.length === 0 || options.length > MAX_PERMISSION_OPTIONS) return undefined;
  const result = new Map<string, PermissionKind>();
  for (const raw of options) {
    const option = record(raw);
    if (!option || typeof option.optionId !== "string" || identifier(option.optionId) === undefined ||
        result.has(option.optionId) ||
        (option.kind !== "allow_once" && option.kind !== "allow_always" &&
         option.kind !== "reject_once" && option.kind !== "reject_always")) return undefined;
    result.set(option.optionId, option.kind);
  }
  return result;
}

function isOrdinaryToolRequest(params: JsonRecord | undefined): boolean {
  const tool = record(params?.toolCall);
  return tool !== undefined && identifier(tool.toolCallId) !== undefined &&
    typeof tool.kind === "string" &&
    ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"].includes(tool.kind) &&
    record(record(tool._meta)?.claudeCode)?.toolName !== "ExitPlanMode";
}

function permissionPlanText(params: JsonRecord | undefined): string | undefined {
  const content = record(params?.toolCall)?.content;
  if (!Array.isArray(content)) return undefined;
  const chunks: string[] = [];
  let length = 0;
  for (const item of content) {
    const block = record(item);
    const value = block?.type === "content" ? record(block.content) : undefined;
    if (value?.type !== "text" || typeof value.text !== "string") continue;
    length += value.text.length + 2;
    if (length > MAX_PLAN_CHARS) return undefined;
    chunks.push(value.text);
  }
  const text = chunks.join("\n\n").trim();
  return text || undefined;
}

function isKeepPlanningRequest(params: JsonRecord | undefined): boolean {
  const tool = record(params?.toolCall);
  if (!tool || tool.kind !== "switch_mode" || identifier(tool.toolCallId) === undefined) return false;
  const toolName = record(record(tool._meta)?.claudeCode)?.toolName;
  // Top-level ExitPlanMode requests lack toolName in the deployed adapter;
  // if an adapter supplies it, contradictory identity cannot qualify.
  if (toolName !== undefined && toolName !== "ExitPlanMode") return false;
  const options = params?.options;
  if (!Array.isArray(options) || options.length === 0 || options.length > MAX_PERMISSION_OPTIONS) return false;
  const optionIds = new Set<string>();
  let keepPlanning = false;
  for (const rawOption of options) {
    const option = record(rawOption);
    const optionId = identifier(option?.optionId);
    if (!option || typeof option.optionId !== "string" || optionId === undefined || optionIds.has(optionId)) {
      return false;
    }
    optionIds.add(optionId);
    if (option.optionId === "plan") {
      if (option.kind !== "reject_once") return false;
      keepPlanning = true;
    } else if (option.kind !== "allow_once" && option.kind !== "allow_always") {
      return false;
    }
  }
  return keepPlanning;
}
