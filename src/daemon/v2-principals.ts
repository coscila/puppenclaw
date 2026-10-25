import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";

import type { PrincipalRegistry } from "../advanced/principals.js";
import { PuppenclawError } from "../shared/errors.js";
import { redactSensitiveText } from "../shared/utils.js";
import { identityEnvelope, type DaemonIdentity } from "./identity.js";

/**
 * pcp/2 run principals (plan P3, capability `principals:1`):
 * PUT|GET|DELETE /v2/principals/{id}. Authenticated by the daemon-wide bearer
 * hook, and refused outright when the daemon runs without a token, like the
 * other authority-bearing routes (owner cleanup, statistics erasure). Every
 * response, errors included, carries the identity envelope.
 */

export type V2PrincipalRouteDeps = {
  identity: DaemonIdentity;
  principals: PrincipalRegistry;
  authenticated: boolean;
};

function failureStatus(error: unknown): [number, string] {
  if (error instanceof ZodError) return [400, "INVALID_PRINCIPAL"];
  if (!(error instanceof PuppenclawError)) return [500, "INTERNAL_ERROR"];
  switch (error.code) {
    case "PRINCIPAL_NOT_FOUND":
      return [404, error.code];
    case "PRINCIPAL_CONFLICT":
    case "PRINCIPAL_REVOKED":
    case "PRINCIPAL_NAME_CONFLICT":
      return [409, error.code];
    case "PRINCIPAL_SOCKET_UNAVAILABLE":
    case "DAEMON_SHUTTING_DOWN":
      return [503, error.code];
    default:
      return [500, error.code];
  }
}

function issues(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.map(String).join(".") || "(body)"}: ${issue.message}`).join("; ");
}

export function registerV2PrincipalRoutes(app: FastifyInstance, deps: V2PrincipalRouteDeps): void {
  const envelope = () => identityEnvelope(deps.identity);
  const fail = (reply: FastifyReply, error: unknown) => {
    const [status, code] = failureStatus(error);
    const text = error instanceof ZodError ? `Invalid principal: ${issues(error)}` : error instanceof Error ? error.message : String(error);
    return reply.code(status).send({ ok: false, ...envelope(), code, error: redactSensitiveText(text) });
  };
  const requireAuthentication = (reply: FastifyReply) =>
    deps.authenticated
      ? null
      : reply.code(503).send({ ok: false, ...envelope(), code: "DAEMON_AUTH_REQUIRED", error: "Principals require daemon bearer authentication." });
  const principalId = (params: unknown) => (params as { id: string }).id;

  app.put("/v2/principals/:id", async (request, reply) => {
    const refused = requireAuthentication(reply);
    if (refused) return refused;
    try {
      return { ok: true, ...envelope(), ...(await deps.principals.put(principalId(request.params), request.body)) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/v2/principals/:id", async (request, reply) => {
    const refused = requireAuthentication(reply);
    if (refused) return refused;
    try {
      const detail = deps.principals.detail(principalId(request.params));
      if (!detail) throw new PuppenclawError("PRINCIPAL_NOT_FOUND", "Unknown principal.");
      return { ok: true, ...envelope(), ...detail };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete("/v2/principals/:id", async (request, reply) => {
    const refused = requireAuthentication(reply);
    if (refused) return refused;
    const cancel = (request.query as { cancel?: string } | undefined)?.cancel;
    try {
      const result = await deps.principals.revoke(principalId(request.params), { cancel: cancel === "1" || cancel === "true" });
      return { ok: true, ...envelope(), ...result };
    } catch (error) {
      return fail(reply, error);
    }
  });
}
