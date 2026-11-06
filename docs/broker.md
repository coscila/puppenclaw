# Advanced orchestration and the broker

A turn can launch worker jobs and route its model traffic through puppenclaw's broker. The broker meters and receipts
every call that passes through it, adds API keys from the daemon's environment to the upstream calls it makes, enforces
capacity, egress and worker policies, and reports settled work on the pcp/2 event feed
([pcp2.md](pcp2.md#event-feed)). Run principals ([pcp2.md](pcp2.md#run-principals)) use the same broker without a
chat turn.

## Orchestrated turns

`POST /session/start` and `POST /session/:name/send` accept an `orchestration` object:

```json
{"version": 1, "revision": 3,
 "workers": [{"id": "reader", "assignment": "Summarise each source.", "agent": "codex", "effort": "medium",
              "modelProvider": {"id": "llm-low", "kind": "codex-openai-compatible", "model": "local-llm",
                                "baseUrl": "http://127.0.0.1:8080/v1", "authTokenEnv": "LOCAL_LLM_API_KEY"}}]}
```

Worker ids are unique, and a worker's `agent` must match its provider (`claude` exactly for `claude-code`). Optional
worker policy fields are described [below](#worker-policy). The turn itself needs a `statisticsContext` and a session
model provider (`ORCHESTRATION_CONTEXT_REQUIRED` otherwise), and one session runs one orchestrated attempt at a time
(`ORCHESTRATION_BUSY`). A session persists the workers that carry no policy, so a later turn without `orchestration`
reuses them; workers with a policy are never persisted, so a turn read back from state can never run them with fewer
restrictions.

At the session's first orchestrated turn, the daemon opens a Unix socket (`0600`, in a `0700` directory
`/tmp/ocsl-model-broker-<uid>-<hash>`); later turns of the session reuse it, and purging the session removes it. The
agent starts with `PUPPENCLAW_ORCHESTRATION_SOCKET`, `PUPPENCLAW_ORCHESTRATION_NATIVE_BASE_PATH` (`/native`) and
`PUPPENCLAW_ORCHESTRATION_ATTEMPT_ID`. Outside an admitted attempt, requests on the socket get
`ORCHESTRATION_TURN_CLOSED` and CONNECT tunnels are closed.

The daemon only opens the socket and sets these variables. An agent's own model calls and web requests reach the
broker only where the deployment points them at the socket
([What a deployment provides](../README.md#what-a-deployment-provides)). The agent inherits the daemon's environment;
for providers other than `claude-code`, only the variable named by its own provider's `authTokenEnv` holds a
placeholder instead of the key.

When the agent finishes while its worker jobs are still running, the daemon waits for them and continues the same turn
with a lifecycle notification that lists the settled jobs, so the agent integrates their results before the turn ends.
Jobs the agent has already read in full (`GET /jobs`, `GET /jobs/{id}`, or the final page of `GET /jobs/{id}/results`)
count as integrated; summary reads do not.

## Socket routes

| Route | Meaning |
| --- | --- |
| `GET /configs` | Workers, capacity per provider (`limit`, admitted `active`, `waiting`, `capacityGroup`), `authorization` (`attemptId`, `workspace`, `publicLiteratureAllowed`), installed policy-wrapped instruments and `revision`. |
| `POST /agent/submit` | `{configId, idempotencyKey, task}`: an agent job. |
| `POST /bulk/submit` | `{configId, idempotencyKey, items: [{id, input}], schema?, concurrency?, instrumentDigest?}`: a bulk job. |
| `GET /jobs` | The parent session's jobs (`?view=summary&after=&limit=` for pages). |
| `GET /jobs/{id}` | One job (`?view=summary` without prompts and results). |
| `GET /jobs/{id}/results?after=&limit=` | The latest state of each changed item. |
| `POST /jobs/{id}/cancel`, `POST /jobs/{id}/resume` | Cancel a job, or continue its unfinished items as a new job. |
| `/native/...` | The agent's own model calls through the recorded transport. |
| absolute `http://` URLs, `CONNECT` | The egress proxy for public web hosts. |

Submissions accept `?view=summary`. Any other route answers `UNKNOWN_WORKER_ROUTE`. Refusals answer 403 for worker
policy codes, 400 for malformed requests and 409 for conflicts, with `{error, code}`. A request body may be up to
64 MiB.

### Agent jobs

An agent job runs a separate agent session (`worker-<jobId>`) with the worker's agent, model provider and effort, in the
parent's directory and with the parent turn's permission and interaction mode. Its prompt starts with the broker's
worker policy, followed by the assignment and the task as quoted data, so neither can override the parent's
permissions, scope or approval boundaries. The job has its own socket; worker jobs cannot submit further jobs
(`WORKER_DELEGATION_DENIED`) or cancel and resume jobs (`WORKER_CONTROL_DENIED`). Its single item settles with the usage
of all its native calls.

### Bulk jobs

A bulk job sends each item as one tool-free model call. It needs a `codex-openai-compatible` worker provider with
`baseUrl` and `authTokenEnv` (`BULK_UNAVAILABLE`) and bulk authority: an `execute` turn with `approve-all`
(`BULK_EXECUTION_REQUIRED`), or a run principal. Items have unique ids. An optional JSON Schema (`schema`) asks for
structured answers: a malformed, invalid or cut answer fails the item with `STRUCTURED_OUTPUT_INVALID`, and an output
cut at the token limit is marked `truncated`. A job that names an installed instrument takes its settings from the
bundle instead ([pcp2.md](pcp2.md#instruments)). `concurrency` (default 60) is capped by the provider's capacity. The
same `idempotencyKey` with the same work returns the existing job; with other work it answers 409
`WORKER_KEY_CONFLICT`.

Without an instrument, an item `input` is a string (one user message) or
`{messages, max_tokens?, max_output_tokens?, temperature?, top_p?, seed?, reasoning?, thinking?, chat_template_kwargs?}`
(`temperature` defaults to 0, `reasoning` to the worker's effort). The call goes to the provider's Responses API with the
broker's worker policy as the system prompt and the worker's assignment and the messages as quoted data.

Job states are `queued`, `running`, `paused`, `completed`, `failed`, `cancelled` and `interrupted`. A job is committed
before the submission returns, so a caller never holds a job id the store could lose. Cancellation stops queued items
and aborts running calls.

### Native model calls

The agent's own model traffic goes to `/native/` + one of `v1/messages` (and `count_tokens`), `v1/responses` (and
`compact`), `v1/chat/completions` or `backend-api/codex/responses`. The requested model must be the turn's configured
model (`MODEL_NOT_CONFIGURED`); the only exception is the separately pinned model of Claude Code's own permission
classifier, admitted unchanged. Native Claude calls use the agent's subscription OAuth (an `x-api-key` is refused with
`PROVIDER_AUTHENTICATION_REQUIRED`); for `codex-openai-compatible` providers the broker adds the key from the
provider's `authTokenEnv`. Each call gets a receipt that reaches the session's statistics and usage ledger as it
settles.

For Claude Code turns the daemon also runs an OAuth relay: Claude Code's token refresh requests to `platform.claude.com`
reach the real endpoint through the socket, verified by a certificate the relay issues for that host only
(`PUPPENCLAW_ORCHESTRATION_CLAUDE_OAUTH_CERT`). The relay never reads profiles, stores tokens or writes receipts.

### Egress

Absolute `http://` requests and `CONNECT` tunnels reach public web hosts on ports 80 and 443. The broker resolves DNS
itself, follows CNAMEs, pins the address it connects to, and refuses (`EGRESS_DENIED`) IP literals, `localhost`,
`.local` and `.internal` names, private, loopback, link-local and other non-public addresses, and every host on its
deny list, also when reached through a CNAME or a shared address:

- the known API hosts `api.anthropic.com`, `platform.claude.com`, `api.openai.com`, `chatgpt.com` and
  `api.langdock.com`;
- the base URL of each orchestrated turn's provider (`https://api.anthropic.com` when it has none) and of its
  workers' providers;
- the values of daemon environment variables whose names contain `LANGDOCK`, `QWEN`, `PAIS`, `ANTHROPIC` or `OPENAI`
  and end in `BASE_URL`, `API_URL` or `ENDPOINT`;
- the direct upstreams.

Provider hosts join the list when the first orchestrated turn that names them is admitted and stay on it until the
daemon stops. A provider configured only in `PUPPENCLAW_MODEL_PROVIDERS`, for run principals, is not on the list. A TLS
tunnel must present a ClientHello whose server name matches the `CONNECT` authority; encrypted ClientHellos are
refused. The egress proxy can tell hosts apart but cannot read TLS contents.

### Refusals

Every request the broker refuses because it reaches outside the participant's boundaries becomes a `broker.refusal`
event in the feed ([pcp2](pcp2.md#event-payloads)), with the participant, what the request reached for and the
refusal's code:

| Kind | Refusals | Target |
| --- | --- | --- |
| `egress` | `EGRESS_DENIED`: a destination, alias or address the egress proxy denies, a TLS or HTTP authority mismatch, and any `CONNECT`, absolute-form request or upgrade naming a host on a run principal's socket, which tunnels nothing | `host:port` |
| `grant` | `PRINCIPAL_REQUIRED`, `PROVIDER_NOT_GRANTED`, `WORKER_DELEGATION_DENIED`, `WORKER_CONTROL_DENIED`, `WORKER_CONFIG_NOT_FOUND`, `BULK_EXECUTION_REQUIRED`, `WORKER_PERMISSION_DENIED`, `CAPABILITY_PROFILE_DENIED`, `PROVIDER_NOT_ON_PREMISES`, and `PRINCIPAL_AGENT_UNSUPPORTED` (agent work or a native model route on a run principal's socket) | provider, worker, job or instrument; `agent` or `native` |
| `instrument` | `INSTRUMENT_NOT_ALLOWED`, `INSTRUMENT_NOT_GRANTED`, `INSTRUMENT_REQUIRED`, `INSTRUMENT_NOT_PINNED`, and `INSTRUMENT_MESSAGE_MISMATCH` (an item whose messages deviate from its verbatim instrument, refused at dispatch) | instrument digest (or the worker) |
| `credential` | `PROVIDER_AUTHENTICATION_REQUIRED` (an API key on a subscription OAuth route), `OAUTH_ROUTE_DENIED`, `OAUTH_REFRESH_REFUSED` (an OAuth relay request other than the agent's own token refresh) | provider or `platform.claude.com:443` |
| `model` | `MODEL_NOT_CONFIGURED` | the requested model |

A refusal the participant cannot cause by reaching further is not recorded: a closed turn, an exhausted budget, a run
principal the lab revoked, whose granted running time ran out or whose grant it withdrew (`PRINCIPAL_REVOKED`,
`PRINCIPAL_EXPIRED`, `GRANT_WITHDRAWN`), a daemon shutting down, a malformed request, and the items of a stored job
refused because configuration changed after the job was admitted (a provider no longer configured on premises, a
bundle stored before the rule it breaks). An event carries no request body, header, prompt, output or credential. The
first refusal of a kind of request is written at once; identical refusals of the same participant and job within the
next minute are counted and written as one more event whose `repeats` holds their number, so a client that repeats a
refused request in a loop cannot flood the feed. Nor can a client that reaches for many targets: beyond 64 targets with
an open minute for one participant, job and code, the further ones share one event whose target is `*`. The counts are
written when their minute ends and when the daemon closes; a daemon that stops without closing loses at most the last
minute's repeats of each request, never its first refusal. Purging a session erases its refusal events like its jobs'
events.

## Provider pauses and retries

A bulk call's HTTP 429 or authentication failure (401, 403) pauses the provider for the attempt at once; a 503 does so
only after the last retry. A paused job carries `resumeAfter` (ISO time) from `Retry-After` or, without it, the latest
provider reset header (`x-ratelimit-reset-*`, `anthropic-ratelimit-*-reset`, `ratelimit-reset`); job listings and
summaries show it. Paused and interrupted jobs need an explicit resume, which keeps completed items.

The broker never retries a [native call](#native-model-calls); the agent's client does. A native 429 or 503 therefore
goes back to the client without pausing the provider, unless its reset, read from the same headers, lies more than 60 s
ahead: Claude Code waits at most 60 s for a retry and ends a call with a later `Retry-After` at once (unless
`CLAUDE_CODE_RETRY_WATCHDOG` is set). A native 401 or 403, and a 429 or 503 with a later reset, pause the provider for
the attempt: the attempt's further native calls get `PROVIDER_PAUSED`, and bulk jobs that the pause holds carry that
reset as `resumeAfter` (a pause that a 401 or 403 sets names none, even after an earlier limit). After a native Claude
401, one call with a renewed login may pass; its success lifts the pause, and so does a 429 with a reset at most 60 s
ahead, which only an accepted login receives.

A client that stops retrying ends its turn with its own error text, which names no failure. A broker-routed turn that
fails while its provider is paused, or right after a 429 or 503 went back to its client (its newest native answer),
therefore ends `PROVIDER_PAUSED`, and the turn's answer carries the provider's reset as `resumeAfter` when one was
named.

A bulk call that times out, meets a connection reset or a refused connection, or gets 502, 503 or 504 is retried with
exponential backoff from `PUPPENCLAW_BULK_RETRY_BASE_MS` (default 1000 ms, ±20 % jitter, at most 30 s), up to
`PUPPENCLAW_BULK_RETRY_ATTEMPTS` attempts (default 3). Every attempt keeps its own receipt, and the item settles once.

## Capacity

Bulk dispatch shares a provider-wide limit across all jobs and sessions of the daemon: `PUPPENCLAW_BULK_PROVIDER_CONCURRENCY`
(default 60) and per-provider overrides in `PUPPENCLAW_BULK_PROVIDER_LIMITS`, for example `{"llm-high": 40}`. The limit
bounds bulk inference only, not native controller calls.

Providers that address the same backend should share a capacity group:

```json
{"llm-none": "llm", "llm-low": "llm", "llm-high": "llm"}
```

in `PUPPENCLAW_BULK_PROVIDER_GROUPS`. A group uses the lowest effective limit of its members (the default for members
without an override) unless `PUPPENCLAW_BULK_GROUP_LIMITS`, for example `{"llm": 60}`, sets it. Unmapped providers keep
their own limits; group names are flat, so a group and an ungrouped provider with the same name stay independent.
Invalid mappings and limits for groups without members fail startup, and changes take effect at the next start. Each
study should also enforce its own budget across its workers, for example through a run principal.

`GET /configs` reports the live counters per provider; grouped providers report the same shared counters, so do not sum
them. An item can be `running` while it waits for a permit, which is not evidence of an upstream slot. The effective
limits are published as `bulkCapacity` in `GET /v2/capabilities` ([pcp2.md](pcp2.md#bulk-capacity)).

Bulk calls use their own transport with a deadline per attempt that covers headers and body:
`PUPPENCLAW_BULK_RESPONSE_TIMEOUT_MS`, default 30 minutes, at most 24 hours, instead of the HTTP client's default
five-minute header timeout. Expiry records `BULK_RESPONSE_TIMEOUT`; cancellation stays immediate.

Worker configurations and job counts have no fixed ceiling; persistent agent sessions are bounded by `maxSessions`.

### Direct upstreams

A provider's registered base URL often points at a local compatibility proxy in front of the inference server.
`PUPPENCLAW_BULK_DIRECT_UPSTREAMS` lets tool-free bulk calls bypass that proxy:

```json
{"http://127.0.0.1:8080/v1": "http://10.0.0.5:8000/v1"}
```

Those calls share one keep-alive connection pool per upstream and capacity group, sized to the group's limit. The broker
applies the rewrites of the proxy it bypasses (tool-policy markers, agent messages turned into user input, repair of
truncated replayed tool calls, at most four images per request); the model and all other fields pass unchanged.
Verbatim instrument calls are sent unchanged. Agents keep using the registered URL, and the mapped upstreams join the
egress deny list.

## Worker policy

A turn may give each worker a policy that the caller decides and the daemon enforces wherever it admits jobs
(`advancedOrchestration.workerPolicy: 1` in `GET /capabilities`, `features.workerPolicy: 1` in `/v2/capabilities`):

- `evidencePolicy`: `public-literature`, `entitled-institutional` (licensed full text under the institution's
  entitlement) or `confidential-manuscript` (an unpublished manuscript of which only identifiers may leave);
- `capabilityProfile`: `code-authoring` (Claude workers only), `evidence-only` (bulk calls on supplied evidence, no
  agent, tools or programs) or `run-fixed-programs` (only the programs it is given: a Claude worker as an agent, any
  other through pinned-instrument bulk calls only);
- `instruments`: 1–16 pinned instruments `{id: "name@version", digest: <sha256 hex>}` with unique ids and digests, for
  evidence-only and run-fixed-programs workers.

`/v2/capabilities` lists `evidencePolicies`, `capabilityProfiles`, `onPremisesProviders` and
`identifierOnlyEgress: "coscila"` under `advancedOrchestration`. Both lists are versioned: an unknown evidence policy
answers 400 `UNSUPPORTED_EVIDENCE_POLICY`, an unknown profile 400 `UNSUPPORTED_CAPABILITY_PROFILE`; they are never
ignored, since ignoring a restriction would grant more than the caller asked for. Combination rules answer 400
`INVALID_WORKER_POLICY`: an entitled-institutional or confidential-manuscript worker must be evidence-only, pinned
instruments belong to an evidence-only or run-fixed-programs worker, and code-authoring needs agent `claude`.

On the turn socket:

- An entitled-institutional or confidential-manuscript worker uses on-premises providers only: its bulk submissions
  answer 403 `PROVIDER_NOT_ON_PREMISES` before any call, `GET /configs` reports it with `bulkAvailable: false`, and an
  item still queued when the configuration changes is refused at dispatch (failed, same code, no call).
- No agent job for an evidence-only worker, nor for a run-fixed-programs or code-authoring worker that is not Claude
  (403 `CAPABILITY_PROFILE_DENIED`).
- A worker with pinned instruments submits bulk work under one of them only (403 `INSTRUMENT_REQUIRED`, 403
  `INSTRUMENT_NOT_PINNED`); a run-fixed-programs worker that is not Claude and pins none has no bulk calls either. A pin
  matches an installed bundle whose `instrumentId` (or `instrumentId@version`) is the pin's id, or whose digest equals
  the pin's digest.
- `GET /configs` lists `capabilityProfile` and `instruments` only for workers that have them; a worker without a policy
  is listed and admitted without these restrictions.

On premises is decided from the daemon's own provider configuration, never from the URL a turn sends, because a
loopback proxy may forward to an external service. `PUPPENCLAW_ONPREM_PROVIDERS` is a JSON array of provider ids, each
configured in `PUPPENCLAW_MODEL_PROVIDERS` with a `baseUrl`. A worker's provider is on premises when its id is listed
and it names the configured kind and endpoint (model, label and credential variable may differ). Unset means no
provider is on premises, so restricted evidence is refused.

Identifier-only egress for confidential-manuscript evidence is enforced by the caller (`identifierOnlyEgress:
"coscila"`): the egress proxy allows or denies hosts and cannot read TLS. On the daemon's side such a worker is
evidence-only, so it gets no agent job and with it no egress tunnel, and its bulk calls go to an on-premises provider
only. Run principals carry no worker policy: their workers come from their grants.

`PUPPENCLAW_WORKER_POLICY=off` advertises nothing and refuses any worker policy field with 400
`WORKER_POLICY_DISABLED` before any session state changes, while orchestrations without one run unchanged.

## Paging large runs

For large runs read summaries and result pages instead of full jobs:

- daemon API: `GET /orchestration/jobs?session=NAME&view=summary&after=0&limit=100` and
  `GET /orchestration/jobs/JOB/results?session=NAME&after=0&limit=100`;
- turn and principal sockets: the same routes without the `/orchestration` prefix and the `session` parameter, and
  `GET /jobs/JOB?view=summary` for one job.

Summary pages omit prompts and results; result pages contain the latest state of each changed item. Both return a
durable numeric `nextCursor` and `hasMore`, with limits 1–1000. Consumers upsert by job and item id, keep the cursor and
continue until `hasMore` is false. An item updated between pages can appear again: these pages are a changed-state feed,
not an event log, so export settled jobs for a complete result set. Reading the final results page of a settled job
acknowledges it for the controller's continuation; summary reads do not.

## The broker store

`advanced/advanced.sqlite` holds jobs, item results, inputs, transport receipts, the outbox and the instrument
allow-list.

- Each result is its own row, and each distinct input is stored once, as a blob keyed by the sha256 of its JSON; a
  resumed job reuses the inputs of its predecessor. A one-item verbatim job of 40 entries stores about 120 KB, so every
  10,000 such jobs add about 1.2 GB. Jobs of run principals are never archived and there is no run-scoped purge: plan
  the volume of a large study run.
- Writes are group-committed: a batch commits as one transaction within `PUPPENCLAW_ADVANCED_COMMIT_WINDOW_MS` (0–50,
  default 50); a batch that fails is replayed write by write, so only the failing write is lost. Every read first
  commits pending writes. A running item lives in memory only; a job header changes with the job state, and item
  progress only moves its revision (at most once per batch) and `updatedAt` (at most once a second). Owner, child
  session and state lookups use expression indexes.
- Statistics and the usage ledger receive bulk receipt updates in batches (newest state per call, at most once a
  second, always before a parent turn's statistics settle).
- On restart, bulk jobs stored in the current layout (inputs as blobs, changes in the outbox) are requeued: their
  unsettled items return to `queued`, and a job relaunches under its own id only when its authority survives the
  restart, which only a run principal's does; other jobs wait as `interrupted` for an explicit resume. Agent jobs, and
  jobs stored in an earlier layout or last rewritten by an older daemon, are interrupted, because ambiguous work is
  never replayed.

Archiving, retention and rollback are described in [operations.md](operations.md).
