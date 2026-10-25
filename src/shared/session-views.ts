import { z } from "zod";

import { jsonToolResult } from "./tool-results.js";
import type { SessionInfo, SessionTranscriptEntry, ToolResult } from "./types.js";
import { redactSensitiveText } from "./utils.js";

/**
 * Compact response shapes (plan H4, capability `compactStatus`). Every shape
 * here is opt-in per request; without the opt-in a route answers exactly as
 * before, so labs that predate pcp/2 keep working.
 */

export const MAX_TRANSCRIPT_LIMIT = 1_000;

/** Query of GET /session/:name and GET /sessions. Unknown keys are ignored as before. */
export const statusViewQueryZod = z.object({
  view: z.enum(["full", "summary"]).optional(),
  transcriptLimit: z.coerce.number().int().min(0).max(MAX_TRANSCRIPT_LIMIT).optional()
});

export type StatusViewQuery = z.infer<typeof statusViewQueryZod>;

export const MAX_TRANSCRIPT_PAGE_ENTRIES = 500;
/** Soft size budget of one transcript page; a page always holds at least one entry. */
export const MAX_TRANSCRIPT_PAGE_CHARS = 1_000_000;

/** Query of GET /session/:name/transcript: `after` = entries already read (seq of the last one). */
export const transcriptPageQueryZod = z.object({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_TRANSCRIPT_PAGE_ENTRIES).default(100)
});

export type TranscriptPage = {
  name: string;
  /** Entries in the transcript now; seq runs from 1 to total. */
  total: number;
  /** Changes when the session is purged; with createdAt it tells a consumer to restart at 0. */
  generation: number;
  createdAt: string;
  after: number;
  entries: Array<SessionTranscriptEntry & { seq: number }>;
  next: number;
  hasMore: boolean;
};

export function transcriptPage(
  session: Pick<SessionInfo, "name" | "createdAt" | "transcript">,
  generation: number,
  after: number,
  limit: number
): TranscriptPage {
  const total = session.transcript.length;
  const entries: TranscriptPage["entries"] = [];
  let chars = 0;
  for (let index = after; index < total && entries.length < limit; index += 1) {
    const entry = session.transcript[index]!;
    if (entries.length > 0 && chars + entry.text.length > MAX_TRANSCRIPT_PAGE_CHARS) {
      break;
    }
    entries.push({ seq: index + 1, ...entry });
    chars += entry.text.length;
  }
  const next = after + entries.length;
  return {
    name: session.name,
    total,
    generation,
    createdAt: session.createdAt,
    after,
    entries,
    next,
    hasMore: next < total
  };
}

export type TranscriptSummary = {
  entries: number;
  lastRole: SessionTranscriptEntry["role"] | null;
  lastEntryAt: string | null;
  lastTurnId: string | null;
};

export function summarizeTranscript(transcript: readonly SessionTranscriptEntry[]): TranscriptSummary {
  const last = transcript.at(-1);
  return {
    entries: transcript.length,
    lastRole: last?.role ?? null,
    lastEntryAt: last?.createdAt ?? null,
    lastTurnId: last?.turnId ?? null
  };
}

/**
 * The session without its transcript, plus a transcript summary. With a limit,
 * the newest `limit` entries are kept and the summary still counts all of them.
 */
export function compactSessionView<T extends SessionInfo>(
  session: T,
  transcriptLimit?: number
): Omit<T, "transcript"> & { transcript?: SessionTranscriptEntry[]; transcriptSummary: TranscriptSummary } {
  const { transcript, ...rest } = session;
  return {
    ...rest,
    ...(transcriptLimit != null ? { transcript: tail(transcript, transcriptLimit) } : {}),
    transcriptSummary: summarizeTranscript(transcript)
  };
}

function tail<T>(values: readonly T[], limit: number): T[] {
  return limit <= 0 ? [] : values.slice(-limit);
}

/** Full status view with the transcript cut to its newest `limit` entries. */
export function limitStatusTranscripts(result: ToolResult, limit: number): ToolResult {
  const details = result.details as Record<string, unknown>;
  const label = result.content.find((block) => block.type === "text")?.text.split("\n")[0] ?? "Status";
  if (Array.isArray(details.sessions)) {
    return jsonToolResult(
      {
        ...details,
        sessions: (details.sessions as SessionInfo[]).map((session) => limitTranscript(session, limit))
      },
      label
    );
  }
  if (details.session != null) {
    return jsonToolResult({ ...details, session: limitTranscript(details.session as SessionInfo, limit) }, label);
  }
  return result;
}

function limitTranscript<T extends SessionInfo>(session: T, limit: number): T & { transcriptSummary: TranscriptSummary } {
  return {
    ...session,
    transcript: tail(session.transcript, limit),
    transcriptSummary: summarizeTranscript(session.transcript)
  };
}

/**
 * Session snapshot for turn-scoped start/send results. It has exactly the
 * fields of the snapshot a keyed turn replays (state of the session and of its
 * latest turn, redacted), so keyed and unkeyed results share one shape; the
 * conversation transcript is never part of it.
 */
export function turnSessionSnapshot(session: Record<string, unknown>): Record<string, unknown> {
  const text = (value: unknown): string | undefined =>
    typeof value === "string" ? redactSensitiveText(value) : undefined;
  const activeTurn = session.activeTurn as Record<string, unknown> | undefined;
  return {
    name: session.name,
    state: session.state,
    lastActivity: session.lastActivity,
    ...(session.pendingQuestion != null ? { pendingQuestion: text(session.pendingQuestion) } : {}),
    ...(session.lastError != null ? { lastError: text(session.lastError) } : {}),
    ...(session.failureCode != null ? { failureCode: session.failureCode } : {}),
    ...(session.retryable != null ? { retryable: session.retryable } : {}),
    ...(activeTurn != null
      ? {
          activeTurn: {
            ...activeTurn,
            ...(activeTurn.error != null ? { error: text(activeTurn.error) } : {})
          }
        }
      : {}),
    ...(session.tokenUsage != null ? { tokenUsage: session.tokenUsage } : {})
  };
}

/**
 * Turn-scoped start/send result (`resultView: "turn"`): this turn's output and
 * signals plus a session snapshot, without the session transcript, absolute
 * context paths or skill source paths. The keyed and unkeyed paths yield the
 * same shape.
 */
export function turnScopedResult(result: ToolResult): ToolResult {
  const details = result.details as Record<string, unknown>;
  const session = details.session;
  const contextFiles = Array.isArray(details.contextFiles)
    ? (details.contextFiles as Array<{ path?: unknown; bytes?: unknown; truncated?: unknown }>).map((file) => ({
        path: typeof file.path === "string" ? (file.path.split(/[\\/]/u).at(-1) ?? file.path) : "",
        bytes: file.bytes,
        truncated: file.truncated
      }))
    : undefined;
  const skills = Array.isArray(details.skills)
    ? (details.skills as Array<{ name?: unknown }>).map((skill) => ({ name: skill.name }))
    : undefined;
  return {
    content: result.content,
    details: {
      view: "turn",
      ...details,
      ...(session != null && typeof session === "object"
        ? { session: turnSessionSnapshot(session as Record<string, unknown>) }
        : {}),
      ...(contextFiles != null ? { contextFiles } : {}),
      ...(skills != null ? { skills } : {})
    }
  };
}
