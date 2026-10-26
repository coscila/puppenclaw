import type { FastifyInstance, FastifyReply } from "fastify";
import { z, ZodError } from "zod";

import type { AdvancedRuntime } from "../advanced/runtime.js";
import { EVENT_PAGE_DEFAULT, EVENT_PAGE_MAX, EVENT_WAIT_MAX_MS } from "../advanced/outbox.js";
import { FeedCursorError, InstrumentConflictError } from "../advanced/store.js";
import { instrumentDigestZod } from "../advanced/types.js";
import { PuppenclawError } from "../shared/errors.js";
import { redactSensitiveText } from "../shared/utils.js";
import { identityEnvelope, type DaemonIdentity } from "./identity.js";

/**
 * pcp/2 broker routes (capabilities eventFeed:1, brokerOutbox:1, instrumentMode:1).
 * All are authenticated by the daemon-wide bearer hook, and every body carries
 * the identity envelope {protocol, bootId, spoolId}.
 *
 * - GET  /v2/events?after=<seq>&limit=<1..1000>&waitMs=<0..25000>: the broker
 *   outbox in seq order; a long poll returns as soon as an event after `after`
 *   is committed. A cursor beyond the head is refused (INVALID_EVENT_CURSOR).
 * - POST /v2/events/ack {feedId, through}: durable, never moves backwards;
 *   another feedId is refused (FEED_REPLACED).
 * - PUT  /v2/instruments/{digest} and GET /v2/instruments: the instrument
 *   allow-list (see src/advanced/instruments.ts).
 */
export type V2BrokerRouteDeps = { identity: DaemonIdentity; advanced: AdvancedRuntime };

const seq = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const eventsQueryZod = z.object({
  after: z.string().regex(/^\d{1,15}$/u).default("0"),
  limit: z.coerce.number().int().min(1).max(EVENT_PAGE_MAX).default(EVENT_PAGE_DEFAULT),
  waitMs: z.coerce.number().int().min(0).max(EVENT_WAIT_MAX_MS).default(0)
}).passthrough();
const ackBodyZod = z.object({ feedId: z.string().min(1).max(128), through: seq.refine(Number.isSafeInteger) }).strict();

function issues(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.map(String).join(".") || "(body)"}: ${issue.message}`).join("; ");
}

export function registerV2BrokerRoutes(app: FastifyInstance, deps: V2BrokerRouteDeps): void {
  const store = deps.advanced.store;
  const envelope = () => identityEnvelope(deps.identity);
  const refuse = (reply: FastifyReply, status: number, code: string, error: string) =>
    reply.code(status).send({ ok: false, ...envelope(), code, retryable: false, error: redactSensitiveText(error) });

  // A long poll must not hold a shutdown: wake every waiter as soon as close begins.
  app.addHook("preClose", async () => { store.wakeAll(); });

  app.get("/v2/events", async (request, reply) => {
    const parsed = eventsQueryZod.safeParse(request.query ?? {});
    if (!parsed.success) {
      const cursor = parsed.error.issues.some((issue) => issue.path[0] === "after");
      return refuse(reply, 400, cursor ? "INVALID_EVENT_CURSOR" : "INVALID_PARAMS", issues(parsed.error));
    }
    const after = Number(parsed.data.after);
    try {
      if (after > store.head()) return refuse(reply, 400, "INVALID_EVENT_CURSOR", "after is beyond the newest event; restart the feed from 0.");
      if (parsed.data.waitMs > 0) {
        const abort = new AbortController();
        const gone = () => abort.abort();
        reply.raw.once("close", gone);
        try { await store.waitForEvents(after, parsed.data.waitMs, abort.signal); }
        finally { reply.raw.removeListener("close", gone); }
      }
      return { ok: true, ...envelope(), ...store.events(after, parsed.data.limit) };
    } catch (error) {
      if (error instanceof FeedCursorError) return refuse(reply, 400, error.code, error.message);
      throw error;
    }
  });

  app.post("/v2/events/ack", async (request, reply) => {
    const parsed = ackBodyZod.safeParse(request.body ?? {});
    if (!parsed.success) return refuse(reply, 400, "INVALID_PARAMS", issues(parsed.error));
    try {
      return { ok: true, ...envelope(), acked: store.ack(parsed.data.feedId, parsed.data.through) };
    } catch (error) {
      if (error instanceof FeedCursorError) return refuse(reply, error.code === "FEED_REPLACED" ? 409 : 400, error.code, error.message);
      throw error;
    }
  });

  app.put("/v2/instruments/:digest", async (request, reply) => {
    const digest = instrumentDigestZod.safeParse((request.params as { digest?: string }).digest);
    if (!digest.success) return refuse(reply, 400, "INVALID_INSTRUMENT_DIGEST", issues(digest.error));
    try {
      const record = deps.advanced.installInstrument(digest.data, request.body);
      return { ok: true, ...envelope(), digest: record.digest, settingsSha256: record.settingsSha256 };
    } catch (error) {
      if (error instanceof InstrumentConflictError) return refuse(reply, 409, error.code, error.message);
      if (error instanceof ZodError) return refuse(reply, 400, "INVALID_INSTRUMENT", issues(error));
      if (error instanceof PuppenclawError && error.code === "INVALID_INSTRUMENT") return refuse(reply, 400, error.code, error.message);
      throw error;
    }
  });

  app.get("/v2/instruments", async () => {
    const instruments = deps.advanced.instruments().map((record) => ({
      digest: record.digest,
      instrumentId: record.bundle.instrumentId,
      version: record.bundle.version,
      itemsPerCall: record.bundle.itemsPerCall,
      settingsSha256: record.settingsSha256,
      installedAt: record.installedAt
    }));
    return { ok: true, ...envelope(), digests: instruments.map((entry) => entry.digest), instruments };
  });
}
