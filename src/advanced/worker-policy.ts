import { z } from "zod";

import { PuppenclawError } from "../shared/errors.js";
import type { AdvancedOrchestration, ModelProviderConfig, PersistedAdvancedOrchestration } from "../shared/types.js";
import type { AgentSubmit, BulkSubmit, WorkerConfig } from "./types.js";

/**
 * Worker policy (plan E4, capability advancedOrchestration.workerPolicy). coscila decides a worker's capability
 * profile, evidence policy and pinned instruments; the daemon enforces them wherever it decides job admission:
 *
 * - entitled-institutional and confidential-manuscript workers use on-premises providers only, as if granted
 *   model:onprem-only. On premises is decided from the daemon's own provider configuration, never from the URL a
 *   turn sends: a provider id listed in PUPPENCLAW_ONPREM_PROVIDERS and configured in PUPPENCLAW_MODEL_PROVIDERS, with
 *   the turn's provider naming the same kind and endpoint. A loopback or private address proves nothing (the lab's
 *   loopback proxies forward to external services too).
 * - evidence-only workers take bulk calls on supplied evidence: no agent job.
 * - run-fixed-programs workers run only the programs they are given: a Claude worker as an agent (coscila's sandbox
 *   wrapper mounts its workspace read-only), any other through bulk calls of its pinned instruments only, never as an
 *   agent.
 * - code-authoring belongs to Claude workers only (the schema refuses it on any other worker).
 * - a worker with pinned instruments submits bulk work under one of them only.
 *
 * Confidential-manuscript's identifier-only egress stays with coscila: the daemon's egress proxy allows or denies hosts
 * and tunnels TLS it cannot read, so it cannot tell identifiers from manuscript text. On the daemon's side such a
 * worker is evidence-only, so it never gets an agent job and with it no egress tunnel at all; its bulk calls go to its
 * on-premises provider only.
 */

export const RESTRICTED_EVIDENCE_POLICIES: ReadonlySet<string> = new Set(["entitled-institutional", "confidential-manuscript"]);
export const WORKER_POLICY_DISABLED = "WORKER_POLICY_DISABLED";
export const CAPABILITY_PROFILE_DENIED = "CAPABILITY_PROFILE_DENIED";
export const PROVIDER_NOT_ON_PREMISES = "PROVIDER_NOT_ON_PREMISES";
export const INSTRUMENT_REQUIRED = "INSTRUMENT_REQUIRED";
export const INSTRUMENT_NOT_PINNED = "INSTRUMENT_NOT_PINNED";
/** Worker-policy refusals of a socket request: the caller asked for work its worker may not do (HTTP 403). */
export const WORKER_POLICY_REFUSAL_CODES: ReadonlySet<string> = new Set([CAPABILITY_PROFILE_DENIED, PROVIDER_NOT_ON_PREMISES, INSTRUMENT_REQUIRED, INSTRUMENT_NOT_PINNED]);

export type WorkerPolicySettings = {
  /** PUPPENCLAW_WORKER_POLICY (default on): off refuses every worker policy field and advertises nothing, as 426d493. */
  enabled: boolean;
  /** Providers configured as on premises, by id (onPremisesProvidersFromEnvironment). */
  onPremises: ReadonlyMap<string, ModelProviderConfig>;
};
export const DEFAULT_WORKER_POLICY: WorkerPolicySettings = { enabled: true, onPremises: new Map() };

type PolicyFields = Pick<WorkerConfig, "evidencePolicy" | "capabilityProfile" | "instruments">;

export function isRestrictedEvidencePolicy(policy: string | undefined): boolean {
  return policy !== undefined && RESTRICTED_EVIDENCE_POLICIES.has(policy);
}

/** Whether a worker carries a worker policy field older daemons cannot read (coscila's export-v2 rule). */
export function workerHasPolicy(worker: PolicyFields): boolean {
  return worker.capabilityProfile !== undefined || worker.instruments !== undefined || (worker.evidencePolicy !== undefined && worker.evidencePolicy !== "public-literature");
}

/**
 * What of a turn's orchestration a session may persist: the workers without worker policy fields, in the frozen shape
 * older daemons load (persistedAdvancedOrchestrationZod). A worker with a policy is left out rather than persisted
 * without it, so an orchestration read back from state (a later turn that sends none) can never run that worker with
 * fewer restrictions. Undefined when no worker remains.
 */
export function persistedOrchestration(config: AdvancedOrchestration): PersistedAdvancedOrchestration | undefined {
  const workers: PersistedAdvancedOrchestration["workers"] = [];
  for (const worker of config.workers) {
    if (workerHasPolicy(worker)) continue;
    const { evidencePolicy, capabilityProfile: _profile, instruments: _instruments, ...rest } = worker;
    workers.push({ ...rest, ...(evidencePolicy === "public-literature" ? { evidencePolicy } : {}) });
  }
  return workers.length > 0 ? { version: 1, revision: config.revision, workers } : undefined;
}

/**
 * The session with what it may persist of a turn's orchestration (persistedOrchestration). When nothing may be kept, an
 * orchestration persisted by an earlier turn goes too: it would describe workers this turn no longer runs as they were.
 * Without a turn orchestration the session is returned unchanged.
 */
export function sessionWithOrchestration<T extends { orchestration?: PersistedAdvancedOrchestration }>(session: T, config: AdvancedOrchestration | undefined): T {
  if (!config) return session;
  const persisted = persistedOrchestration(config);
  if (persisted) return { ...session, orchestration: persisted };
  const { orchestration: _stale, ...rest } = session;
  return rest as T;
}

/** A turn's orchestration fields refused while PUPPENCLAW_WORKER_POLICY is off; undefined when it carries none. */
export function workerPolicyDisabledError(config: AdvancedOrchestration, settings: WorkerPolicySettings): PuppenclawError | undefined {
  if (settings.enabled) return undefined;
  const workers = config.workers.filter(workerHasPolicy).map((worker) => worker.id);
  return workers.length === 0 ? undefined : new PuppenclawError(WORKER_POLICY_DISABLED,
    `This daemon runs with PUPPENCLAW_WORKER_POLICY=off and accepts no worker policy fields (workers ${workers.join(", ")}); send them only to a daemon that advertises advancedOrchestration.workerPolicy.`, { workers });
}

/** PUPPENCLAW_WORKER_POLICY: `on` (default) accepts and enforces worker policy fields; `off` refuses them. */
export function workerPolicyEnabledFromEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PUPPENCLAW_WORKER_POLICY?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "on") return true;
  if (raw === "off") return false;
  throw new Error("PUPPENCLAW_WORKER_POLICY must be on or off.");
}

const providerIdZod = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/u);

/**
 * PUPPENCLAW_ONPREM_PROVIDERS: a JSON array of provider ids the operator declares on premises. Each must be configured
 * in PUPPENCLAW_MODEL_PROVIDERS (`providers`) with a baseUrl, so the declaration names an endpoint the daemon knows.
 * Unset means no provider is on premises: restricted evidence policies are then refused. Invalid values fail startup,
 * like the other broker settings.
 */
export function onPremisesProvidersFromEnvironment(env: NodeJS.ProcessEnv, providers: ReadonlyMap<string, ModelProviderConfig>): Map<string, ModelProviderConfig> {
  const raw = env.PUPPENCLAW_ONPREM_PROVIDERS?.trim();
  if (!raw) return new Map();
  const shape = "PUPPENCLAW_ONPREM_PROVIDERS must be a JSON array of provider ids configured in PUPPENCLAW_MODEL_PROVIDERS.";
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(shape); }
  const parsed = z.array(providerIdZod).max(256).safeParse(value);
  if (!parsed.success) throw new Error(shape);
  const onPremises = new Map<string, ModelProviderConfig>();
  for (const id of parsed.data) {
    if (onPremises.has(id)) throw new Error(`PUPPENCLAW_ONPREM_PROVIDERS lists provider ${id} twice.`);
    const provider = providers.get(id);
    if (!provider) throw new Error(`PUPPENCLAW_ONPREM_PROVIDERS lists provider ${id}, which PUPPENCLAW_MODEL_PROVIDERS does not configure.`);
    if (endpointOf(provider) === null) throw new Error(`PUPPENCLAW_ONPREM_PROVIDERS lists provider ${id}, which has no valid baseUrl in PUPPENCLAW_MODEL_PROVIDERS.`);
    onPremises.set(id, provider);
  }
  return onPremises;
}

/** The endpoint a provider's calls go to, normalised as the broker builds upstream URLs (no trailing / or /v1). */
function endpointOf(provider: Pick<ModelProviderConfig, "baseUrl">): string | null {
  if (!provider.baseUrl) return null;
  let url: URL;
  try { url = new URL(provider.baseUrl); } catch { return null; }
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "")}`;
}

/**
 * Whether a worker's provider is on premises: its id is declared on premises and it names the configured kind and
 * endpoint. Model, label and credential variable may differ (one endpoint serves several reasoning profiles).
 */
export function isOnPremisesProvider(provider: ModelProviderConfig, onPremises: ReadonlyMap<string, ModelProviderConfig>): boolean {
  const configured = onPremises.get(provider.id);
  if (!configured) return false;
  const endpoint = endpointOf(provider);
  return endpoint !== null && endpoint === endpointOf(configured) && (provider.kind ?? null) === (configured.kind ?? null);
}

/** The installed instrument a bulk job names, as far as pins compare it: its digest and its id@version. */
export type InstalledInstrumentIdentity = { digest: string; instrumentId: string; version: string | number };

/**
 * Whether an installed instrument is one of the worker's pins. coscila pins the registry's id@version and registry
 * digest, while the daemon allow-lists the broker digest coscila-review derives from it (instruments.py
 * broker_bundle), so the daemon matches the installed bundle's instrumentId (name@version) or instrumentId@version,
 * or a digest equal to a pin; it cannot recompute the registry digest of an installed bundle.
 */
export function instrumentPinned(pins: NonNullable<WorkerConfig["instruments"]>, installed: InstalledInstrumentIdentity): boolean {
  const ids = new Set([installed.instrumentId, `${installed.instrumentId}@${installed.version}`]);
  return pins.some((pin) => pin.digest === installed.digest || ids.has(pin.id));
}

/**
 * Why a worker's bulk calls cannot run whatever they carry, or undefined: a restricted evidence policy on a provider
 * that is not on premises, or a run-fixed-programs worker that is not Claude and pins no instrument.
 */
export function workerBulkRefusal(worker: WorkerConfig, settings: WorkerPolicySettings): PuppenclawError | undefined {
  if (isRestrictedEvidencePolicy(worker.evidencePolicy) && !isOnPremisesProvider(worker.modelProvider, settings.onPremises)) {
    return new PuppenclawError(PROVIDER_NOT_ON_PREMISES,
      `Worker ${worker.id} holds evidence policy ${worker.evidencePolicy}, which goes to on-premises providers only, and this daemon does not configure provider ${worker.modelProvider.id} at that endpoint as on premises (PUPPENCLAW_ONPREM_PROVIDERS).`,
      { workerId: worker.id, evidencePolicy: worker.evidencePolicy, providerId: worker.modelProvider.id });
  }
  if (worker.capabilityProfile === "run-fixed-programs" && worker.agent !== "claude" && !worker.instruments?.length) {
    return new PuppenclawError(INSTRUMENT_REQUIRED,
      `Worker ${worker.id} runs fixed programs and is not Claude, so it runs only its pinned instruments as bulk calls, and it pins none.`,
      { workerId: worker.id, capabilityProfile: worker.capabilityProfile });
  }
  return undefined;
}

/**
 * Why the daemon refuses to admit this job for this worker, or undefined. `instrument` is the installed instrument a
 * bulk job names (undefined when it names none). Workers without policy fields are never refused here.
 */
export function workerJobRefusal(worker: WorkerConfig, kind: "agent" | "bulk", request: AgentSubmit | BulkSubmit, settings: WorkerPolicySettings, instrument?: InstalledInstrumentIdentity): PuppenclawError | undefined {
  if (!workerHasPolicy(worker)) return undefined;
  if (kind === "agent") {
    const profile = worker.capabilityProfile;
    const refused = profile === "evidence-only" || isRestrictedEvidencePolicy(worker.evidencePolicy)
      ? "takes bulk calls on supplied evidence and runs no agent, tools or programs"
      : (profile === "run-fixed-programs" || profile === "code-authoring") && worker.agent !== "claude"
        ? profile === "run-fixed-programs"
          ? "is not Claude, so it runs its programs as pinned-instrument bulk calls, never as an agent (an agent with a shell could author programs)"
          : "is not Claude, and only Claude workers author code"
        : undefined;
    return refused === undefined ? undefined : new PuppenclawError(CAPABILITY_PROFILE_DENIED,
      `Worker ${worker.id} (${profile ?? `evidence policy ${worker.evidencePolicy}`}) ${refused}.`, { workerId: worker.id, kind, ...(profile ? { capabilityProfile: profile } : {}) });
  }
  const bulk = workerBulkRefusal(worker, settings);
  if (bulk) return bulk;
  const pins = worker.instruments;
  if (!pins?.length) return undefined;
  const digest = (request as BulkSubmit).instrumentDigest;
  if (digest === undefined || instrument === undefined) {
    return new PuppenclawError(INSTRUMENT_REQUIRED, `Worker ${worker.id} pins instruments (${pins.map((pin) => pin.id).join(", ")}) and submits bulk work under one of them only.`, { workerId: worker.id });
  }
  if (!instrumentPinned(pins, instrument)) {
    return new PuppenclawError(INSTRUMENT_NOT_PINNED, `Worker ${worker.id} pins ${pins.map((pin) => pin.id).join(", ")}; the installed instrument ${instrument.instrumentId} (version ${instrument.version}) is none of them.`, { workerId: worker.id, instrumentDigest: digest });
  }
  return undefined;
}
