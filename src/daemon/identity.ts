import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * pcp/2 identity. Every v2 response body carries `{protocol, bootId, spoolId}`;
 * every HTTP response (v1 included) carries the same values as headers, which
 * no existing JSON consumer can trip over.
 * - bootId: one per daemon process start.
 * - spoolId: one per persisted in-flight state (SessionStore.spoolId).
 * - build: PUPPENCLAW_BUILD_ID when set (release builder), otherwise the package
 *   version plus a digest of the running bundle.
 */
export const PCP_PROTOCOL = Object.freeze({ major: 2, minor: 0 });
export const PCP_PROTOCOL_HEADER_VALUE = `${PCP_PROTOCOL.major}.${PCP_PROTOCOL.minor}`;

export const IDENTITY_HEADERS = Object.freeze({
  protocol: "x-puppenclaw-protocol",
  bootId: "x-puppenclaw-boot-id",
  spoolId: "x-puppenclaw-spool-id"
});

export type IdentityEnvelope = {
  protocol: { major: number; minor: number };
  bootId: string;
  spoolId: string;
};

export type DaemonIdentity = {
  bootId: string;
  build: string;
  startedAt: string;
  startedAtMs: number;
  spoolId: () => string;
};

export function identityEnvelope(identity: DaemonIdentity): IdentityEnvelope {
  return {
    protocol: { major: PCP_PROTOCOL.major, minor: PCP_PROTOCOL.minor },
    bootId: identity.bootId,
    spoolId: identity.spoolId()
  };
}

export function identityHeaders(identity: DaemonIdentity): Record<string, string> {
  return {
    [IDENTITY_HEADERS.protocol]: PCP_PROTOCOL_HEADER_VALUE,
    [IDENTITY_HEADERS.bootId]: identity.bootId,
    [IDENTITY_HEADERS.spoolId]: identity.spoolId()
  };
}

const BUILD_ID_PATTERN = /^[A-Za-z0-9._+:-]{1,128}$/u;

export async function resolveBuildId(
  env: NodeJS.ProcessEnv = process.env,
  entryUrl: string = import.meta.url
): Promise<string> {
  const explicit = env.PUPPENCLAW_BUILD_ID?.trim();
  if (explicit != null && BUILD_ID_PATTERN.test(explicit)) {
    return explicit;
  }
  const version = await readFile(new URL("../../package.json", entryUrl), "utf8")
    .then((raw) => {
      const parsed = JSON.parse(raw) as { version?: unknown };
      return typeof parsed.version === "string" ? parsed.version : "unknown";
    })
    .catch(() => "unknown");
  const digest = await readFile(fileURLToPath(entryUrl))
    .then((content) => createHash("sha256").update(content).digest("hex").slice(0, 12))
    .catch(() => "unknown");
  return `${version}+${digest}`;
}
