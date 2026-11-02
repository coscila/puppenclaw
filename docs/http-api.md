# HTTP API, version 1

The daemon's version 1 routes run sessions, campaigns, compute jobs and accounting. pcp/2 ([pcp2.md](pcp2.md)) adds
routes and opt-in response shapes on top of them; every route described here is still served.

## Conventions

- **Authentication.** With `daemonAuthToken` set, every route except `GET /health` and `GET /capabilities` requires
  `Authorization: Bearer <token>`; without it the answer is `401 {"ok": false, "error": "unauthorized"}`.
- **Identity headers.** Every response carries `x-puppenclaw-protocol: 2.0`, `x-puppenclaw-boot-id` and
  `x-puppenclaw-spool-id` (see [pcp2.md](pcp2.md#identity)). Version 1 bodies carry the same values only when a
  request opts into a compact view.
- **Envelope.** Session, campaign, usage and statistics routes answer `{"content": [{"type": "text", "text": "..."}],
  "details": {...}}`: a readable text and the structured result. `format: "json"` asks for JSON text where a route
  offers both.
- **Errors.** `{"ok": false, "code": "...", "error": "...", "details"?: {...}}`. Invalid parameters answer 400
  `INVALID_PARAMS` (or a typed code such as `UNSUPPORTED_EVIDENCE_POLICY`), unexpected failures 500 `INTERNAL_ERROR`.
  The compute routes answer `{"error": "..."}` with 400 or 404. Error texts are redacted before they leave the daemon.
- **Read-only state.** When persisted state needs an operator reset, every request except `GET` routes,
  `POST /recovery/reset`, `POST /shutdown` and `DELETE /v2/principals/{id}` answers 503 `STATE_RECOVERY_REQUIRED`.

| Status | Codes |
| --- | --- |
| 400 | `INVALID_PARAMS`, `MODEL_UNAVAILABLE`, `UNSUPPORTED_EVIDENCE_POLICY`, `UNSUPPORTED_CAPABILITY_PROFILE`, `INVALID_WORKER_POLICY`, `WORKER_POLICY_DISABLED` |
| 404 | `NO_SESSION` |
| 409 | `TURN_ALREADY_RUNNING`, `SESSION_BUSY`, `TURN_KEY_CONFLICT`, `TURN_REPLAY_UNAVAILABLE`, `TURN_RECEIPT_CAPACITY_REACHED`, `STALE_TURN_GENERATION`, `SESSION_QUIESCED`, `STALE_QUIESCENCE_EPOCH`, `LIFECYCLE_EPOCH_REQUIRED`, `STALE_LIFECYCLE_EPOCH`, `OWNER_SCOPE_QUIESCED`, `SESSION_OWNER_CONFLICT`, `OWNER_CLEANUP_CONFLICT`, `OWNER_ADOPTION_UNPROVEN`, `STATISTICS_CONTEXT_REUSED`, `STATISTICS_CONTEXT_PURGED`, `FORK_TARGET_CLAIMED`, `RECOVERY_FENCE_ACTIVE`, `PROVIDER_PAUSED` |
| 424 | `PROVIDER_AUTHENTICATION_REQUIRED` |
| 503 | `DAEMON_AUTH_REQUIRED`, `OWNER_CLEANUP_INCOMPLETE`, `QUIESCENCE_UNAVAILABLE`, `ACP_CONTROL_TIMEOUT`, `PROVIDER_CONNECTION_FAILED`, `PROVIDER_AUTHENTICATION_BUSY`, `STATE_RECOVERY_REQUIRED` |
| 500 | any other code |

## Discovery

- `GET /health` (open): `{ok, sessions, stateRecovery}`; `ok` is false while state needs a reset.
- `GET /capabilities` (open): the version 1 capability document. It lists the supported session operations,
  `sessionTurnIdempotency`, `sessionQuiescence`, `sessionOwnerCleanup` (only with a token), `conversationStatistics`,
  `providerFailureContracts`, `codexLocalSubagents`, `reasoning` (profiles, modes and aliases), `claudeWorkflows`,
  `advancedOrchestration`, `stateRecovery`, `maxSessions`, `streamOutput` and `defaultAgent`. A client should send an
  optional field only to a daemon that advertises it: the request schemas are strict.
- `GET /skills`: the skills available to sessions (`skillRoots`).

## Turns

`POST /session/start` creates or reuses the session `name` and runs one turn; `POST /session/:name/send` runs a turn in
an existing session. Both return when the turn has ended. `POST /session/start/stream` and
`POST /session/:name/send/stream` run the same turn and answer with server-sent events.

`POST /session/start` body:

| Field | Meaning |
| --- | --- |
| `agent`, `name`, `directory`, `task` | Required. The agent (`claude`, `codex`), the session name, its working directory and the prompt. |
| `permissionMode` | `approve-reads`, `approve-all` or `deny-all` for this turn; a configured `deny-all` always wins. |
| `interactionMode` | `plan` (read-only planning) or `execute`. |
| `effort`, `model`, `planningProfile` | Reasoning effort (see [configuration](configuration.md#model-providers)), a model override, and `off`, `quick` or `deep` planning guidance. |
| `modelProvider`, `modelProviderId` | The model provider of the session. |
| `turnKey` | Makes the turn keyed (see [keyed turns](pcp2.md#keyed-turns)). |
| `statisticsContext` | `{version: 1, chatId, attemptId}`: attributes the turn's statistics (see [statistics](#usage-and-statistics)). |
| `ownerKey` | Opaque account selector, 16–128 characters (needs a bearer token; see [account cleanup](#account-cleanup)). |
| `lifecycleEpoch` | Required after an external quiescence of this name (see [lifecycle fencing](#lifecycle-fencing)). |
| `orchestration` | Worker configurations for advanced orchestration (see [broker](broker.md)). |
| `contextFiles`, `skills` | Files attached to the prompt (relative paths resolve against `directory`; at most 6 files, each truncated to 32 KiB) and skills to install for the session. |
| `resultView`, `keyedStreaming` | pcp/2 response opt-ins; never part of the turn's fingerprint. |

`POST /session/:name/send` takes `message` instead of `agent`, `directory` and `task`, plus the same `permissionMode`,
`interactionMode`, `effort`, `turnKey`, `statisticsContext`, `orchestration`, `lifecycleEpoch`, `modelProvider`,
`modelProviderId`, `contextFiles`, `resultView` and `keyedStreaming`.

### Streaming

A stream answers `text/event-stream`; each event is `event: <kind>` with a JSON `data` line:

| Event | Meaning |
| --- | --- |
| `chunk` | Assistant text delta (the stream opens with an empty `chunk`). |
| `activity` | Tool and progress updates. |
| `final` | The final assistant message. |
| `question` | The agent asks the user something. |
| `complete` | The runtime reported the end of the turn. |
| `error` | A failure, with `code`, `retryable` and `details` where known. |
| `gap` | Progress events were dropped for a slow client: `droppedEvents`, `droppedBytes`. |
| `result` | The same result the non-stream route returns. |
| `done` | Last event. |

Each stream writes straight through while the client reads. When the client falls behind, events wait in the stream's
own queue and text deltas are coalesced; once the queue would exceed `PUPPENCLAW_SSE_MAX_PENDING_BYTES` (default
8 MiB), further `chunk` and `activity` events are replaced by one `gap` event. `final`, `question`, `complete`,
`error`, `result` and `done` are never dropped, and a stalled client never slows the agent. Idle streams carry a
heartbeat comment every 15 s.

An unkeyed turn's stream carries the session's live output. A keyed turn's stream carries only its result unless the
request sets `keyedStreaming: true`; it then streams that turn's own output, and a repeated request for the same running
key joins the remaining output. Replays and rejected requests never see another turn's output.

### Provider failures

Provider failures reach the caller without raw credential diagnostics. A turn that the provider rejects is a terminal
session result, not a failed HTTP request: JSON answers 200 with the failed session, a safe message, `failureCode` and
`retryable`; a stream emits the same typed `error` followed by that `result`. Every keyed replay preserves this shape,
and session status, active-turn metadata and turn receipts keep the code. `GET /capabilities` advertises the contract
as `providerFailureContracts` version 3:

- `PROVIDER_AUTHENTICATION_REQUIRED`: terminal until an operator renews the provider login;
- `PROVIDER_CONNECTION_FAILED`: retryable;
- `PROVIDER_AUTHENTICATION_BUSY`: temporary contention while Claude Code refreshes its credentials; retryable, and not a
  sign of an invalid login;
- `PROVIDER_PAUSED`: the broker paused the provider for this attempt after a rate limit or authentication failure.

`retryable` never replays a dispatched turn automatically, because partial work may already exist.

### Final answers and interrupted turns

Assistant progress, tool output and the final answer are separate. A provider Codex turn takes its answer from Codex's
final-message file, or from an explicitly final JSON message with confirmed turn completion; commentary alone fails the
turn with `NO_FINAL_MESSAGE` and never replays an earlier answer. Native terminal failures and unexpected signals also
fail; a stop requested by the user stays cancelled. `activeTurn.exitCode` and `activeTurn.signal` report what happened.

An acpx reconnect banner never authorises a replay. A persisted reply needs the identity of the current submission and
an observed completion. The only automatic retry is a queue request that the runtime explicitly rejected before
dispatch; missing acknowledgements and partial work are not resubmitted.

Claude planning turns have one narrow exception to acpx's nonzero-exit handling: exit code 5 can mean that the
read-only boundary answered "No, keep planning" when the agent asked to leave plan mode. A fresh answer, a correlated
`end_turn` and a final permission exchange holding the plan then publish that plan for approval. Every permission
request must have a matched decision, none may have been approved, and when other tools asked for permission the
offered plan is required. Missing evidence, errors, signals, later tool requests and `deny-all` remain failures. The
actual exit code stays in the diagnostics; the exception neither approves the plan nor retries a denied tool.

## Session state

- `GET /sessions` and `GET /session/:name`: sessions with their transcripts and an `acpx status` probe.
  - `view=summary` drops the transcript (adds `transcriptSummary`) and the probe. Where only the runtime can classify a
    session, the summary still carries it: `runtime.status: "quiesced"` for a quiesced session, and the probe result for
    a session stored as `running` without an active turn.
  - `transcriptLimit=N` (0–1000) keeps the newest N entries in either view.
- `GET /session/:name/output`: the latest output and a session snapshot; takes the same `view` and `transcriptLimit`.
- `GET /session/:name/transcript?after=SEQ&limit=N` (1–500, default 100, at most about 1 MB of text per page):
  entries with `seq`, plus `total`, `next`, `hasMore`, `createdAt` and the session `generation`, which changes when the
  session is purged.
- `GET /session/:name/processes`: the session's process tree and resource use.

Compact views and the transcript page add `protocol`, `bootId` and `spoolId` to the body.

## Session control

| Route | Effect |
| --- | --- |
| `POST /session/:name/resume` | Reconnect a suspended or stopped session. |
| `POST /session/:name/suspend` | Disconnect an idle session's runtime and keep its transcript. |
| `POST /session/:name/focus` `{ttlMs?}` | Protect the session from idle eviction for a lease of 5–300 s. |
| `POST /session/:name/unfocus` | Release the lease. |
| `POST /session/:name/fork` `{target, model?, effort?}` | Create `target` from this session's transcript. |
| `DELETE /session/:name` | Stop the session and its running turn. |
| `POST /session/:name/purge` | Remove the session, its transcript, diagnostics and broker jobs. Statistics stay. |
| `POST /gc` | Purge sessions past `sessionTtlMinutes`. |

### Lifecycle fencing

A caller that must stop a session, or remove its workspace, without a delayed dispatch reopening it uses a fenced
lifecycle (`sessionQuiescence` version 2):

1. `POST /session/:name/quiesce` durably fences new mutations, drains the active turn, closes the runtime and returns
   a positive `details.quiescenceEpoch` with `details.runtimeClosed: true`. Quiescing an unknown name is valid and
   fences a racing first start.
2. `POST /session/:name/purge` removes the session and keeps an external fence.
3. `POST /session/start` or `/send` may resume work with that exact `lifecycleEpoch`; entering the turn releases the
   matching fence atomically. Once a name has lifecycle history, every later start or send must carry its latest epoch;
   missing and stale epochs stay refused, also after a release or a restart.
4. `POST /session/:name/quiesce/release` `{"epoch": N}` releases the fence without starting a turn. Releasing the latest
   epoch again is idempotent; stale epochs are refused.

External fences and the latest epoch per name are stored apart from the session, so a restart, purge or retried cleanup
never silently reopens a fenced name. The daemon's own purge and garbage collection use transient fences that also
survive an interrupted purge but create no lifecycle history; an external quiesce that meets an interrupted transient
purge adopts its fence. Session status reports an externally fenced session as stopped, its runtime as `quiesced`.
Names that were never quiesced externally never need an epoch. `lifecycleEpoch` exists only on the authenticated
daemon API, not in the OpenClaw plugin's commands or tools.

### Account cleanup

Account deletion can fence and remove every session of an opaque owner selector (`sessionOwnerCleanup` version 1,
advertised only with a bearer token). Send the same 16–128 character `ownerKey` with each `POST /session/start` of the
account. Then:

- `POST /sessions/owner/list` `{ownerKey}` lists the owner's sessions;
- `POST /sessions/owner/quiesce` and `POST /sessions/owner/purge`
  `{ownerKey, operationKey, sessionNames?}` fence and remove them. Reuse one `operationKey` for retries.

`sessionNames` adopts sessions that were created without an owner key: the daemon binds only sessions that exist and
have no owner (or already belong to this owner), refuses conflicting ownership and fails closed when it cannot prove that
a named session is gone. Owner claims survive the purge, so a retry can prove a named session was already removed. The
first cleanup call installs a durable fence against new sessions of the owner. A purge also revokes the owner's run
principals and erases their broker jobs, and answers `brokerErasuresPending`: the number of the owner's broker jobs
whose records wait for the event feed acknowledgement. The account's data is erased once that is 0; repeat the purge
until then. If the daemon cannot prove that every matched runner has ended, it answers `OWNER_CLEANUP_INCOMPLETE` with
`recoveryRequired: true` and keeps the fence. The owner key is never returned by session or cleanup responses.

## Usage and statistics

- `GET /usage?since=&format=`: token usage rolled up by provider and model.
- `GET /session/:name/cost?limit=N` (1–1000): the session's usage history; also served for sessions that were removed
  from the registry.
- `GET /usage/ledger?afterId=SEQ&limit=N` (1–1000, default 500): ledger rows in insertion order with `seq`, `next`,
  `hasMore`, `head` and a stable `ledgerId`. `afterId` also accepts a row id. An unknown row id or a seq beyond `head`
  (a cursor of another copy of the ledger) answers 400 `INVALID_LEDGER_CURSOR`: read from the start then.

**Conversation statistics** (`conversationStatistics` version 1). A start or send may attach
`statisticsContext: {version: 1, chatId, attemptId}`; turns without it are not tracked, and session names never imply
attribution. The context is part of the turn fingerprint, so replaying a turn key never charges an attempt twice. Agent
tools cannot set it.

- `GET /statistics/turns?cursor=0&limit=100` (1–500): `details` with `daemonId`, `nextCursor`, `hasMore` and the latest
  value of each changed turn. Every checkpoint and settlement advances a global revision. Consumers upsert by daemon and
  turn id, never sum revisions, and rescan after a `daemonId` change. A bad cursor answers 400
  `INVALID_STATISTICS_CURSOR`.
- `POST /statistics/chats/:chatId/purge` (needs a bearer token): permanent erasure after the chat's runtimes are torn
  down; `details` is `{version: 1, chatId, purged: true, removedTurns}`. Live attempts refuse erasure. It is idempotent,
  keeps the revision monotonic and fences delayed writes with a digest of the chat id. Session purge, model changes and
  garbage collection keep statistics.

Runtime is the active runner time, not summed child wall time. Input tokens include cache reads and writes; cache and
reasoning counts are subsets of the total. Null means not observed, never zero. Failed and cancelled attempts keep the
usage observed so far. CPU time sums kernel counters of the verified host process tree, excludes managed compute jobs
and is always labelled partial coverage; it does not cover remote model inference. Recovery after a restart keeps the
last checkpoint and marks the turn interrupted.

## Resources

- `GET /resources`: a current snapshot of host and per-session CPU, memory and process counts from `/proc`.
- `GET /resources/history?since=&until=&bucketSeconds=&session=`: bucketed history (`bucketSeconds` 30–86400, by
  default about 500 points; `since` defaults to 24 hours before `until`).

## Worker jobs

The broker's jobs, by parent session (see [broker](broker.md)):

- `GET /orchestration/jobs?session=NAME&view=summary&after=0&limit=100`: summaries without prompts or results;
  `metadata-only=true` returns job headers only; without either option, full jobs.
- `GET /orchestration/jobs/:jobId/results?session=NAME&after=0&limit=100`: the latest state of each changed item.
- `GET /orchestration/receipts?session=&attempt=`: transport receipts of model calls.

Pages carry a durable numeric `nextCursor` and `hasMore`; limits are 1–1000, and a bad cursor answers 400
`INVALID_WORKER_CURSOR`.

## Compute jobs

Managed compute jobs run commands outside the agent session, in a Bubblewrap sandbox launched by the deployment's
trusted launcher (see [Security model](../README.md#security-model)).

- `GET /compute/capacity`: `{executors: [{id, available, hardLimits, reason}]}` for `bubblewrap-local`,
  `rootless-docker`, `slurm`, `htcondor` and `psij`. Only `bubblewrap-local` runs jobs; it needs workspace roots, a
  trusted launcher and policy, and a working `bwrap`. CPU and memory are metered, not hard-limited.
- `POST /compute/jobs` with `{jobId, executor, command, cwd, env?, resources: {cpuCores, memoryMiB, wallTimeSeconds,
  gpuCount?, diskMiB?}, sessionName?, principalId?}`: idempotent per `jobId`, also for overlapping submissions. `cwd`
  must lie inside the workspace roots, GPUs are refused, and `principalId` must name an unrevoked principal with an
  open socket, whose binding then reaches the launcher (see [pcp2.md](pcp2.md#binding-a-principal-socket-into-a-sandbox)).
- `GET /compute/jobs/:id`, `GET /compute/jobs/:id/logs?tailBytes=65536` (plain text),
  `POST /compute/jobs/:id/cancel`.

A detached supervisor process runs each job and records its state, so jobs outlive a daemon restart and are reconciled
when the daemon starts. States: `queued`, `starting`, `running`, `succeeded`, `failed`, `cancelled`, `interrupted`,
`orphaned`. Records carry exit code, peak memory, CPU seconds and I/O bytes.

## Campaigns and site

The `/orchestrator/*` routes take the same parameters as the plugin's campaign tools
([openclaw-plugin.md](openclaw-plugin.md)):

| Route | Operation |
| --- | --- |
| `POST /orchestrator/project` | Register a project root and its metadata. |
| `POST /orchestrator/worker` | Register or update a worker manifest. |
| `POST /orchestrator/context-sync` | Capture project files and notes into a context bundle. |
| `POST /orchestrator/campaign` | Run a campaign from a template or custom steps. |
| `GET /orchestrator/status?campaignId=&projectId=` | Projects, campaigns, workers and runs. |
| `GET /orchestrator/artifacts?campaignId=&projectId=` | Artifacts of campaigns. |
| `GET /orchestrator/artifacts/:artifactId/content?limitChars=&format=` | Bounded artifact text. |
| `GET /orchestrator/events?campaignId=&after=&limit=` | Campaign events. |
| `POST /orchestrator/approve`, `POST /orchestrator/cancel` `{campaignId}` | Resume a campaign waiting for approval, or cancel one. |
| `POST /orchestrator/reassessment`, `GET /orchestrator/reassessment/status`, `GET /orchestrator/reassessment/report` | Model reassessment runs. |
| `GET /site/status?verbose=` | Runtime health, capacity, workers and remote-control exposure. |
| `GET /site/logs?sessionName=\|campaignId=\|runId=&limitChars=&follow=` | Bounded logs of one session, campaign or run. |

Campaign `command` steps run shell commands on the host (when `orchestration.allowLocalCommandExecution` is true),
which is one reason an unauthenticated daemon belongs on loopback only.

## Operations routes

- `GET /ops/idle`: counts measured now, never names: `activeTurns`, `turnProcesses`, `runnerProcesses`,
  `runningTurnKeys`, `brokerJobsActive`, `brokerJobsPaused`, `computeJobsActive`, `streams`, and restart survivors that
  may still be alive: `recoveryFencedSessions` (sessions fenced after a restart whose recorded process is not proven
  gone; the next dispatch clears the fence once it is), `leftoverRunnerGroups` (runner groups of earlier boots still
  running) and `recoveryFencesWithoutProcess` (fences that record no process: nothing to wait for, but such a session
  refuses new turns with `RECOVERY_FENCE_ACTIVE` until it is stopped).
- `POST /recovery/reset` `{"confirm": "reset-session-state"}`: leaves read-only recovery with fresh session state and a
  new spool; without the confirmation it answers 400 `RESET_CONFIRMATION_REQUIRED`.
- `POST /shutdown`: answers `{ok: true}` and closes the daemon as on `SIGTERM`.
