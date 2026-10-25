import { z } from "zod";

import { jsonToolResult } from "./tool-results.js";
import type { SessionInfo, SessionTranscriptEntry, ToolResult } from "./types.js";

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
