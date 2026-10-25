import { ensureError, PuppenclawError } from "./errors.js";
import type { PluginLogger } from "./logger.js";

export type OutputRouteEvent =
  | {
      kind: "chunk";
      sessionName: string;
      text: string;
    }
  | {
      kind: "activity";
      sessionName: string;
      activity: {
        type: "tool_call" | "tool_output" | "status";
        text?: string;
        title?: string;
        status?: string;
        toolCallId?: string;
      };
    }
  | {
      kind: "final";
      sessionName: string;
      text: string;
    }
  | {
      kind: "complete";
      sessionName: string;
      text: string;
    }
  | {
      kind: "error";
      sessionName: string;
      text: string;
      code?: string;
      retryable?: boolean;
      details?: Record<string, unknown>;
    }
  | {
      kind: "question";
      sessionName: string;
      text: string;
    };

export type OutputDispatcher = (event: OutputRouteEvent) => Promise<void> | void;

/**
 * Identity token returned by {@link OutputRouter.attach}. Detaching requires
 * the exact token, so a concurrent second subscriber can never clobber or
 * remove another subscriber's dispatcher.
 */
export type OutputSubscription = {
  readonly sessionName: string;
  readonly dispatcher: OutputDispatcher;
  /**
   * Turn-scoped subscription: only events emitted while the keyed turn with
   * this key is executing are delivered. Session output is otherwise shared by
   * every turn of the session, so a replay or a rejected request must never see
   * another turn's output.
   */
  readonly turnKey?: string;
};

/** Key of the keyed turn executing in a session right now, or null. */
export type TurnKeyResolver = (sessionName: string) => string | null;

type SessionBuffer = {
  pending: string;
};

export class OutputRouter {
  private readonly buffers = new Map<string, SessionBuffer>();

  private readonly subscriptions = new Map<string, Set<OutputSubscription>>();

  private turnKeyResolver: TurnKeyResolver | null = null;

  constructor(
    private readonly logger: PluginLogger,
    private readonly options: {
      flushThreshold?: number;
    } = {}
  ) {}

  attach(
    sessionName: string,
    dispatcher: OutputDispatcher,
    options: { turnKey?: string } = {}
  ): OutputSubscription {
    const subscription: OutputSubscription = {
      sessionName,
      dispatcher,
      ...(options.turnKey != null ? { turnKey: options.turnKey } : {})
    };
    const existing = this.subscriptions.get(sessionName);
    if (existing != null) {
      existing.add(subscription);
    } else {
      this.subscriptions.set(sessionName, new Set([subscription]));
    }
    return subscription;
  }

  /** Set by the session manager, which knows which keyed turn is executing. */
  setTurnKeyResolver(resolver: TurnKeyResolver | null): void {
    this.turnKeyResolver = resolver;
  }

  detach(subscription: OutputSubscription): void {
    const existing = this.subscriptions.get(subscription.sessionName);
    if (existing == null) {
      return;
    }
    existing.delete(subscription);
    if (existing.size === 0) {
      this.subscriptions.delete(subscription.sessionName);
    }
  }

  async onChunk(sessionName: string, chunk: string): Promise<void> {
    if (!chunk) {
      return;
    }
    const buffer = this.ensureBuffer(sessionName);
    buffer.pending += chunk;
    await this.flushBufferedChunks(sessionName, false);
  }

  async onComplete(sessionName: string, summary: string): Promise<void> {
    await this.flushBufferedChunks(sessionName, true);
    if (!summary.trim()) {
      return;
    }
    await this.dispatch(sessionName, {
      kind: "complete",
      sessionName,
      text: summary.trim()
    });
  }

  async onActivity(
    sessionName: string,
    activity: Extract<OutputRouteEvent, { kind: "activity" }>["activity"]
  ): Promise<void> {
    await this.dispatch(sessionName, {
      kind: "activity",
      sessionName,
      activity
    });
  }

  async onFinal(sessionName: string, text: string): Promise<void> {
    await this.flushBufferedChunks(sessionName, true);
    const finalText = text.trim();
    if (!finalText) {
      return;
    }
    await this.dispatch(sessionName, {
      kind: "final",
      sessionName,
      text: finalText
    });
  }

  async onError(
    sessionName: string,
    error: Error,
    metadata: { code?: string; retryable?: boolean; details?: Record<string, unknown> } = {}
  ): Promise<void> {
    await this.flushBufferedChunks(sessionName, true);
    await this.dispatch(sessionName, {
      kind: "error",
      sessionName,
      text: error.message,
      ...(metadata.code != null
        ? { code: metadata.code }
        : error instanceof PuppenclawError
          ? { code: error.code }
          : {}),
      ...(metadata.retryable != null ? { retryable: metadata.retryable } : {}),
      ...(metadata.details != null ? { details: metadata.details } : {})
    });
  }

  async onQuestion(sessionName: string, question: string): Promise<void> {
    await this.flushBufferedChunks(sessionName, true);
    await this.dispatch(sessionName, {
      kind: "question",
      sessionName,
      text: question.trim()
    });
  }

  flushText(sessionName: string): string {
    const buffer = this.ensureBuffer(sessionName);
    const text = buffer.pending;
    buffer.pending = "";
    return text;
  }

  clear(sessionName: string): void {
    this.buffers.delete(sessionName);
    this.subscriptions.delete(sessionName);
  }

  private ensureBuffer(sessionName: string): SessionBuffer {
    const current = this.buffers.get(sessionName);
    if (current != null) {
      return current;
    }
    const created: SessionBuffer = { pending: "" };
    this.buffers.set(sessionName, created);
    return created;
  }

  private async flushBufferedChunks(sessionName: string, force: boolean): Promise<void> {
    const buffer = this.ensureBuffer(sessionName);
    const threshold = this.options.flushThreshold ?? 240;
    while (buffer.pending.length > 0) {
      const newlineIndex = buffer.pending.indexOf("\n");
      const shouldFlushThreshold = force || newlineIndex >= 0 || buffer.pending.length >= threshold;
      if (!shouldFlushThreshold) {
        return;
      }
      const splitIndex =
        newlineIndex >= 0 ? newlineIndex + 1 : force ? buffer.pending.length : threshold;
      const text = buffer.pending.slice(0, splitIndex);
      buffer.pending = buffer.pending.slice(splitIndex);
      await this.dispatch(sessionName, {
        kind: "chunk",
        sessionName,
        text
      });
      if (!force && newlineIndex < 0) {
        return;
      }
    }
  }

  private async dispatch(sessionName: string, event: OutputRouteEvent): Promise<void> {
    const subscriptions = this.subscriptions.get(sessionName);
    if (subscriptions == null || subscriptions.size === 0) {
      return;
    }
    // Resolved once, before any await: the event belongs to the turn executing now.
    const eventTurnKey = this.turnKeyResolver?.(sessionName) ?? null;
    for (const subscription of [...subscriptions]) {
      if (subscription.turnKey != null && subscription.turnKey !== eventTurnKey) {
        continue;
      }
      try {
        await subscription.dispatcher(event);
      } catch (error) {
        const err = ensureError(error);
        this.logger.warn(`Orchestrator output dispatch failed for ${sessionName}: ${err.message}`);
      }
    }
  }
}
