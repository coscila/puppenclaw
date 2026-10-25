import type { FastifyInstance } from "fastify";

import { STRUCTURED_OUTPUT_DIALECTS } from "../advanced/response-schema.js";
import type { EventLoopMonitor } from "./event-loop.js";
import { identityEnvelope, PCP_PROTOCOL, type DaemonIdentity } from "./identity.js";

/**
 * pcp/2 step 1 routes (plan H4). Both are authenticated by the daemon-wide
 * bearer hook (they are not in its open-route list) and cost O(1): no store
 * scans, no subprocesses, no transcripts.
 */

export type StreamBacklog = {
  streams: number;
  events: number;
  bytes: number;
};

export type V2RouteDeps = {
  identity: DaemonIdentity;
  eventLoop: EventLoopMonitor;
  recoveryRequired: () => boolean;
  activeTurns: () => number;
  pendingStateWrites: () => number;
  streamBacklog: () => StreamBacklog;
  /** Feature flags advertised in /v2/capabilities; each is opt-in per request. */
  features: () => Record<string, number>;
  limits: () => Record<string, number>;
};

export function registerV2Routes(app: FastifyInstance, deps: V2RouteDeps): void {
  app.get("/v2/health", async () => {
    const recoveryRequired = deps.recoveryRequired();
    const backlog = deps.streamBacklog();
    return {
      ok: !recoveryRequired,
      ...identityEnvelope(deps.identity),
      build: deps.identity.build,
      startedAt: deps.identity.startedAt,
      uptimeMs: Date.now() - deps.identity.startedAtMs,
      stateRecovery: { required: recoveryRequired },
      activeTurns: deps.activeTurns(),
      backlog: {
        streams: backlog.streams,
        streamEvents: backlog.events,
        streamBytes: backlog.bytes,
        stateWrites: deps.pendingStateWrites()
      },
      eventLoop: deps.eventLoop.snapshot(),
      rssBytes: process.memoryUsage.rss()
    };
  });

  app.get("/v2/capabilities", async () => ({
    ok: true,
    ...identityEnvelope(deps.identity),
    build: deps.identity.build,
    pcp: { major: PCP_PROTOCOL.major, minor: PCP_PROTOCOL.minor },
    features: deps.features(),
    limits: deps.limits(),
    providers: {
      structuredOutput: STRUCTURED_OUTPUT_DIALECTS.map((dialect) => ({
        reasoningProfile: dialect.reasoningProfile,
        unsupportedKeywords: [...dialect.unsupportedKeywords],
        handling: "removed-from-provider-schema-validated-locally"
      }))
    }
  }));
}
