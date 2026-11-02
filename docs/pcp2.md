# pcp/2

pcp/2 is protocol version 2.0 of the daemon. It keeps every version 1 route ([http-api.md](http-api.md)) and adds
identity, authenticated health and capabilities, keyed turns with compact results, the broker's event feed and
instruments, run principals and bulk capacity. All `/v2/*` routes require the bearer token whenever `daemonAuthToken`
is set; none of them is open like `GET /health`.

## Identity

Every HTTP response, version 1 included, carries three headers, and every `/v2/*` body carries the same values as
`{protocol: {major: 2, minor: 0}, bootId, spoolId}`. The one exception is the `401 {"ok": false, "error":
"unauthorized"}` of the bearer check, which answers before any route and carries the headers only.

| Header | Meaning |
| --- | --- |
| `x-puppenclaw-protocol` | `2.0`. |
| `x-puppenclaw-boot-id` | New on every daemon start. |
| `x-puppenclaw-spool-id` | Identity of the persisted in-flight state (`spool.json`). It changes only when that state is replaced: a fresh data directory, state that could not be loaded, or a recovery reset. A consumer treats a new spool id as the loss of every turn the previous spool held. |

Errors of the `/v2/*` routes add `code` and `error` to the envelope; the broker routes also add `retryable`.

## Health

`GET /v2/health` costs the same whatever the daemon holds (no store scans, subprocesses or transcripts) and answers in
under 1 KB:

| Field | Meaning |
| --- | --- |
| `ok` | False while persisted state needs an operator reset. |
| `build` | `PUPPENCLAW_BUILD_ID`, or the package version plus a digest of the running bundle. |
| `startedAt`, `uptimeMs` | Start time and uptime. |
| `stateRecovery.required` | Whether a recovery reset is pending. |
| `activeTurns` | Turns running now. |
| `backlog` | `streams` (open SSE responses), `streamEvents` and `streamBytes` queued in them, `stateWrites` pending, and `brokerErasures` (broker jobs whose erasure waits for the feed acknowledgement). |
| `eventLoop` | `p99Ms` and `maxMs` of event-loop lag beyond the timer resolution, over a 30 s window (`windowMs`). |
| `memory` | `rssBytes`, `heapUsedBytes`, `heapLimitBytes`. |

## Capabilities

`GET /v2/capabilities` answers `pcp: {major, minor}`, `build`, `features`, `limits`, `providers` and, when they apply,
`advancedOrchestration` and `bulkCapacity`.

| Feature | Level | Meaning |
| --- | --- | --- |
| `health` | 1 | `GET /v2/health`. |
| `opsIdle` | 1 | `GET /ops/idle`. |
| `usageLedger` | 1 | `GET /usage/ledger`. |
| `compactStatus` | 1 | `view=summary`, `transcriptLimit`, `GET /session/:name/transcript`, `resultView: "turn"`. |
| `keyedStreaming` | 1 | Keyed turns may stream their own output. |
| `sseGap` | 1 | Slow streams drop progress events and report a `gap`. |
| `eventFeed` | 1 | `GET /v2/events`, `POST /v2/events/ack`. |
| `brokerOutbox` | 2 | Payload level of the feed events (see [event payloads](#event-payloads)). |
| `instrumentMode` | 1 | `PUT` and `GET /v2/instruments`; bulk jobs that name an instrument. |
| `instrumentVerbatim` | 1 | Instrument bundles with `transport.messages: "verbatim"`. |
| `workerPolicy` | 1 | Worker policies are accepted and enforced (absent with `PUPPENCLAW_WORKER_POLICY=off`). |
| `bulkCapacity` | 1 | The `bulkCapacity` object below. |
| `principals` | 1 | Run principals; advertised only when a bearer token is configured. |
| `legacyAttemptAuthority` | 1 | Chat turns carry bulk authority (`PUPPENCLAW_LEGACY_ATTEMPT_AUTHORITY=on`). |

`limits` holds `turnKeyMax` (128), `ledgerPageMax` (1000), `transcriptLimitMax` (1000), `transcriptPageMax` (500),
`sseMaxPendingBytes`, `eventPageMax` (1000), `eventWaitMsMax` (25000) and `eventInlineOutputMax` (16384).
`providers.structuredOutput` lists the JSON Schema keywords a provider dialect cannot take; the broker removes them from
the schema it sends (for example `uniqueItems` for `qwen-3.8`) and still validates answers against the full schema.
`advancedOrchestration` describes worker policies (see [broker](broker.md#worker-policy)).

### Bulk capacity

`bulkCapacity` reports what bulk dispatch applies, read from the running limiter, transport and retry settings. It holds
numbers and names only, never an endpoint or a credential variable:

```json
{"defaultLimit": 60,
 "providers": [{"providerId": "llm-high", "capacityGroup": "llm", "limit": 40, "groupLimit": 40},
               {"providerId": "llm-low", "capacityGroup": "llm", "limit": 40, "groupLimit": 40}],
 "responseTimeoutMs": 1800000,
 "retry": {"attempts": 3, "baseDelayMs": 1000, "maxDelayMs": 30000}}
```

`providers` lists every provider in `PUPPENCLAW_MODEL_PROVIDERS` and every provider the bulk limits or groups name,
sorted by id. `limit` is the number of calls the provider may have in flight; for a grouped provider it is the group's
limit, shared with every member. Any other provider gets `defaultLimit` in a pool of its own. `responseTimeoutMs` is
the deadline of each attempt, so an item whose calls never answer keeps one of its job's streams busy for up to
`attempts` deadlines plus the backoff between them. A run principal's calls are further bounded by its grant's
`maxConcurrency`. The values are fixed when the daemon starts.

## Keyed turns

Turns run through `POST /session/start` and `POST /session/:name/send` (or their `/stream` variants). A `turnKey`
(1–128 characters of `A-Za-z0-9._:-`) makes a turn keyed (`sessionTurnIdempotency` in `GET /capabilities`):

- The daemon claims the key in its state before the agent starts and records the outcome when the turn settles.
- The same request under the same key waits for the running turn (`concurrentWait`) or replays the recorded result
  (`terminalReplay`). A request is the same when its fingerprint matches: every field of the turn except the response
  opt-ins.
- The same key with a different request answers 409 `TURN_KEY_CONFLICT`.
- A key whose turn was running when the daemon stopped is never launched again. Once the turn's process is proven gone
  (or the turn was never dispatched), the key is settled with the error `TURN_INTERRUPTED_RESTART`, and a repeated
  request replays that error; while the process may still run, a repeat answers 409 `TURN_REPLAY_UNAVAILABLE`. While
  one keyed turn of a session is unsettled, the session refuses a new key with the same code.
- Each session keeps the outcomes of its 64 most recent keyed turns (`terminalReplayRetention`); older keys stay known
  but cannot replay. After 4,096 keys (`turnKeyRetention`) the session refuses new keys with 409
  `TURN_RECEIPT_CAPACITY_REACHED` until it is purged.
- Results and recorded errors of a keyed turn carry `details.turnReceipt: {turnKey, state}`: `accepted` for the request
  that ran the turn, `replayed` for a repeat.

Two opt-ins change only the response, never the turn:

- `"resultView": "turn"`: the result holds this turn's output and signals and the same compact session snapshot a replay
  returns, never the transcript, and carries `protocol`, `bootId` and `spoolId`.
- `"keyedStreaming": true` on a `/stream` route: the keyed turn streams its own live output with the same events as an
  unkeyed turn. A repeated request for a running key joins its remaining output; replays and refused requests never see
  another turn's output. Without it a keyed stream carries only the result.

## Event feed

The broker reports through an acknowledged event feed. `advanced.sqlite` holds an outbox table; every job creation and
state change writes a `broker.job` row, and every bulk item that settles after a provider call writes one
`broker.receipt` row (an item refused before a retry is dispatched settles with the receipt of its last call). Each row
is written in the same transaction as the change itself, so a crash keeps both or loses both. An item gets at most one
receipt row per job; a duplicate completion is refused. Sequence numbers only grow and are never reused, also after
pruning, so gaps can appear only at or below the acknowledged cursor.

- `GET /v2/events?after=SEQ&limit=N&waitMs=MS` (`after` default 0, `limit` 1–1000 with default 500, `waitMs`
  0–25000): `{ok, feedId, events: [{seq, type, at, jobId, itemId?, payload}], next, hasMore, head, acked}` in sequence
  order. With `waitMs` the request returns as soon as an event after `after` is committed, or empty when the wait ends.
  Events are fsynced before they are served, so a served sequence number survives power loss. `after` beyond `head`
  answers 400 `INVALID_EVENT_CURSOR`: the cursor belongs to another outbox; read from 0. `feedId` is stored with the
  outbox and changes only when `advanced.sqlite` is replaced; then restart from 0 (event ids make that idempotent).
- `POST /v2/events/ack` `{feedId, through}`: `{ok, acked}`; durable, and never moves backwards (an older `through`
  returns the current value). Another `feedId` answers 409 `FEED_REPLACED`, a `through` beyond `head` 400
  `INVALID_EVENT_CURSOR`.

Long polls end as soon as the daemon begins to shut down.

### Event payloads

`broker.job`:

```text
{jobId, ownerKey, principalId, runId, state,
 counts: {total, queued, running, succeeded, failed, cancelled, truncated},
 instrumentDigest, createdAt, updatedAt, parentSessionName, attemptId, resumedFromJobId}
```

Absent values are null. `parentSessionName` is the chat's daemon session, or `principal:<id>`; with `attemptId` it ties a
job to its chat. `resumedFromJobId` names the job this one resumes: a resume re-runs a job's unfinished items under their
item ids in a new job, so a consumer counting items per lineage follows it. Counts fold item states into these
categories: paused and interrupted items count as failed (a resume runs them in a new job), and a truncated item counts
once, as truncated. Items in flight when a job pauses or is cancelled settle after that state change; once the job's
execution has drained, one more `broker.job` row with the same state carries the final counts, if they changed.

`broker.receipt`:

```text
{jobId, itemId, attempt, status: succeeded|failed|truncated|cancelled, finishReason,
 usage: {input, output, cacheRead, cacheWrite}, model, serverFingerprint,
 servedModel, systemFingerprint, httpStatus, settingsSha256, requestSha256, instrumentDigest,
 outputDigest, outputBytes, output?, startedAt, endedAt, error: {code, retryable} | null}
```

- `model` and `serverFingerprint` may hold the requested model and the daemon's synthesized identity. `servedModel`,
  `systemFingerprint` and `httpStatus` (level 2) say what the upstream itself answered to the settling call: the model
  its response named, its `system_fingerprint` (each null when it named none) and the HTTP status (null without an HTTP
  response). Agent jobs carry no `servedModel` or `systemFingerprint`.
- `output` is inline only up to 16,384 UTF-8 bytes; larger outputs stay in the job's result pages. `outputDigest` is the
  sha256 of the output as a string, or of its compact JSON when it is structured.
- `requestSha256` is null for agent jobs. Agent jobs report their single item over all its native calls.
- `error.code` comes from a closed set; `PROVIDER_RATE_LIMITED`, `PROVIDER_UNREACHABLE`, `PROVIDER_PAUSED`,
  `TIME_LIMIT`, `NO_FINAL_MESSAGE` and `INTERRUPTED_RESTART` are retryable.

### Receipt provenance

Every broker receipt (bulk call, retried attempt, native controller or agent call) carries `serverFingerprint`: the
upstream's `system_fingerprint` when it sends one, otherwise `<served model>@<16 hex>`, where the hex begins the sha256
of the canonical JSON of the server identity headers present (`server`, `via`, `x-powered-by`, `openai-version`); it is
never empty. `settingsSha256` is the sha256 of the canonical JSON (keys sorted by code point, no whitespace, numbers as
`JSON.stringify` writes them) of exactly `{model, temperature, seed, reasoning, max_tokens, response_format_sha256,
system_prompt_sha256}` as sent, missing values null. Every bulk call's receipt, its item result and its event also carry
`requestSha256`, the sha256 of the same canonical JSON of the whole request body sent upstream. A verbatim instrument
call sends exactly those canonical bytes, so there it is also the digest of the bytes on the wire.

### Erasure and retention

Erasure never runs ahead of the feed, and contents never wait for it. Purging a session (or an owner) erases a job
whose events are all acknowledged at once. A job with unacknowledged events loses its header, items, inputs and
acknowledged events at once, and its unacknowledged receipt events lose their inline `output` (`outputDigest` and
`outputBytes` stay); only its receipt rows and those events wait, and go when the acknowledgement covers them.
`GET /v2/health` reports how many jobs wait (`backlog.brokerErasures`), and `POST /sessions/owner/purge` answers
`brokerErasuresPending` for its owner.

Retention is opt-in: `PUPPENCLAW_EVENT_RETENTION_DAYS` (at least 7) deletes acknowledged events older than that, once an
hour. Unacknowledged events are never deleted.

## Instruments

An instrument is a measurement bundle that fixes the system prompt, output budget, sampling and response schema of bulk
calls. The caller installs it under an opaque digest that the caller computes; the daemon never recomputes a digest and
only allow-lists what was installed.

`PUT /v2/instruments/{digest}` (digest: 1–128 characters of `A-Za-z0-9._:-`, starting with a letter or digit) with:

```text
{instrumentId, version, systemPrompt, responseSchema | null,
 maxOutputTokens: {perItem, minimum}, temperature, seed | null, reasoning, itemsPerCall,
 requiredModelFingerprint | null, transport?: {messages: "policy-wrapped" | "verbatim"}}
```

answers `{ok, digest, settingsSha256, transport}`. The same body again returns the same answer; a different body under
an installed digest answers 409 `INSTRUMENT_DIGEST_CONFLICT`, an invalid one 400 `INVALID_INSTRUMENT`. A response schema
may carry `$id` and `$schema` (draft-07 or 2020-12); each distinct schema is compiled once, on its own validator, and
reused by every job that names it. `GET /v2/instruments` lists `digests` and `instruments` (each with `instrumentId`,
`version`, `itemsPerCall`, `transport`, `settingsSha256` and `installedAt`). The allow-list lives in `advanced.sqlite`
and survives restarts.

The PUT's `settingsSha256` digests the installed settings (the system prompt the upstream receives, the response schema,
sampling, the output-token rule, items per call, the required fingerprint, and `messages: "verbatim"` for a verbatim
bundle); each receipt's `settingsSha256` digests one call. A bundle without `transport` is policy-wrapped, and a
policy-wrapped bundle is stored without the field whether the PUT spells the default out or not, so both PUTs install
the same instrument and daemons without transport modes read it unchanged. A verbatim bundle keeps the field, so such a
daemon refuses it rather than running it policy-wrapped.

### Policy-wrapped instruments

A bulk job that names `instrumentDigest` (`POST /bulk/submit` on a broker socket) runs in instrument mode. A digest that
is not installed answers 400 `INSTRUMENT_NOT_ALLOWED`, and a job `schema` next to it 400 `INSTRUMENT_REQUEST_CONFLICT`.
Each item is a string or `{messages, itemCount}`: user and assistant messages sent after the system prompt, which is the
broker's worker policy, a blank line and the instrument's `systemPrompt`. Per call, `max_output_tokens = max(minimum,
perItem × itemCount)` (`itemCount` defaults to `itemsPerCall`, 1 for a string), and temperature, seed, reasoning effort
and the response schema come from the bundle; an item that tries to set any of them fails with `INVALID_REQUEST`.

`finish_reason=length` (or a Responses `status: incomplete` for `max_output_tokens`) marks the item `truncated: true`: a
text output is kept, a cut structured output fails `STRUCTURED_OUTPUT_INVALID`, and the receipt's status is `truncated`
either way. With `requiredModelFingerprint`, an answer whose fingerprint and served model both differ pauses the job
(`MODEL_DRIFT`) and keeps no output; the check comes before parsing and validation, so it also catches a drifted answer
that is malformed, fails the schema or was cut. A turn socket's `GET /configs` lists the installed policy-wrapped
instruments.

### Verbatim instruments

A bundle with `transport: {messages: "verbatim"}` sends each item's messages upstream exactly as the caller's executor
built them, so prompts stay byte-identical to the instrument's own builders: no worker policy, no assignment, no added
instructions. A verbatim bundle carries no response schema (400 `INVALID_INSTRUMENT`), so the answer is the model's own
text. Only a run principal (one bound to a study run) whose grants include the digest runs a verbatim instrument;
chat-turn authority and human principals never do (409 `PRINCIPAL_REQUIRED`), and turn sockets do not list it.

An item is `{messages, itemCount}`: the complete messages, system message included, and the number of instrument entries
the call carries. It may also repeat the settings of the request the executor built (`model`, `max_tokens`,
`temperature`, `seed`, `reasoning_effort`, `stream`); each must then equal what is sent. Before any call, principal
admission or charge, the daemon refuses the item unless:

- the first message is a system message equal to `systemPrompt` byte for byte, and no other message is a system message;
- every message is exactly `{role, content}` with string content and the role `system`, `user` or `assistant`, and at
  least one is a user message;
- `1 ≤ itemCount ≤ itemsPerCall`;
- a repeated `model` is the worker's model, `max_tokens` is `max(minimum, perItem × itemCount)`, `temperature`, `seed`
  (null when the bundle has none) and `reasoning_effort` (= `reasoning`) are the bundle's, and `stream` is false;
- no tools and no other field are present.

A refused item settles `failed` with `INSTRUMENT_MESSAGE_MISMATCH` (never retried) and an error naming the check (for
the system prompt, the sha256 prefixes of both prompts, never their text); it makes no upstream call and has no
receipt, and the job's other items run. An accepted item goes to `/v1/chat/completions` as the canonical JSON of exactly
`{model, messages, max_tokens, temperature, seed, reasoning_effort, stream: false}`: the worker's model, the messages as
submitted and the bundle's settings, `seed` only when the bundle sets one, and nothing else. The receipt's
`requestSha256` is the sha256 of those bytes, so the executor proves byte identity per call by comparing it with the
canonical digest of the request it built.

The output is the first choice's message content, and `finish_reason=length` marks the item truncated as above. A 2xx
answer whose first choice carries no message with text or null content (no choices, a garbled body, content parts) is
no answer and is asked again like a failed call (`NO_FINAL_MESSAGE`, retryable); an empty completion is asked again
and, once the attempts are spent, settles `completed` with the empty text. Every 4xx other than 401, 403, 404 and 429
settles `INVALID_REQUEST`, and `httpStatus` tells a refused request (400, 413, 422) from a transient one such as 408.
`requiredModelFingerprint` is checked against the served model and `system_fingerprint` only: a response that names
another model or none at all pauses the job (`MODEL_DRIFT`); the requested model is never taken on trust.

Parsing a submission and storing its inputs run on the event loop, so the size of a submission bounds the event-loop
lag it causes (about 90 ms for a 13 MB submission of 100 calls); keep submissions to tens of calls, or submit one call
per job. The digests of a
submission (job fingerprint, item digests, input keys) are computed on a worker thread (`PUPPENCLAW_SUBMISSION_DIGESTS`).

## Run principals

A principal is bulk authority that the caller grants and the daemon enforces: a study run (`kind: "run"`, bound to its
`runId`) or a person (`kind: "human"`, with grants but no run binding). `features.principals: 1` is
advertised only with a bearer token; without one the routes answer 503 `DAEMON_AUTH_REQUIRED`. Ids are 1–128
characters of `A-Za-z0-9._:-`.

- `PUT /v2/principals/{id}` with `{kind, runId, ownerKey, grants: {providers, instruments, maxConcurrency, maxItems,
  tokenBudget: {input, output}, expiresAt}, socket}` returns `{principalId, kind, runId, grants, socketPath, createdAt,
  updatedAt}`. `kind`, `ownerKey` (16–128 characters), `grants.providers` (up to 64) and `grants.maxConcurrency`
  (1–100,000) are required, and `runId` is required for `kind: "run"` and absent for `"human"`. The others default to
  no limit (`maxItems`, `tokenBudget` and its two fields, `expiresAt`: null), no instruments and `socket: false`. With
  `socket: true` the data directory path must leave room for a Unix socket path (`<data-dir>/principals/<16 hex
  characters>/broker.sock` within 107 bytes, so a data directory of at most 67 bytes); otherwise the PUT answers 503
  `PRINCIPAL_SOCKET_UNAVAILABLE`. An invalid body answers 400 `INVALID_PRINCIPAL`. The same body returns the same
  result. Changed grants or a changed `socket` take effect at once and are audited. `kind`, `runId` and `ownerKey`
  never change (409 `PRINCIPAL_CONFLICT`), and a revoked id stays revoked (409 `PRINCIPAL_REVOKED`). No response
  contains `ownerKey`.
- `GET /v2/principals/{id}` adds `state` (`active`, `expired`, `revoked`), `revokedAt`, `revision`, `usage` (admitted
  `items`, settled `inputTokens` and `outputTokens`, `activeItems`, `remaining`), `providersUnavailable` and the last 50
  audit entries.
- `DELETE /v2/principals/{id}[?cancel=1]` returns `{principalId, revokedAt}` and is idempotent. Before it returns, the
  principal's socket is gone and no further item is admitted. Items already dispatching finish, or abort with
  `cancel=1`; every item the principal had not admitted ends `cancelled`. A revocation that a restart interrupted
  completes at the next start. Revocation works also while session state awaits a recovery reset.

### Grants

- `providers` name entries of `PUPPENCLAW_MODEL_PROVIDERS`, the only source of a principal provider's endpoint, model
  and credential variable; a socket client can never choose one.
- `instruments` are installed digests. A principal with instrument grants may submit only jobs that name one of them
  (403 `INSTRUMENT_REQUIRED`, 403 `INSTRUMENT_NOT_GRANTED`), and a granted digest must also be installed (400
  `INSTRUMENT_NOT_ALLOWED`): grants restrict which installed instruments a principal may run, never widen the
  allow-list.
- `maxConcurrency` bounds the dispatching items of all the principal's jobs together. The principal's slot is taken
  before provider capacity, so a principal at its limit holds no provider permit.
- `maxItems` caps the items the principal admits over its lifetime, exactly. An item counts once per job lineage (a job
  and the jobs resumed from it), at its first admission: a retry, a relaunch after a restart and a resume admit it again
  without counting it again, and an admission that dispatched no call gives its count back. Counted items persist in
  `principals.sqlite`.
- `tokenBudget` caps the settled input tokens (every prompt token the provider reports, cached ones included) and
  output tokens. Calls already dispatching, at most `maxConcurrency` of them, can overshoot it.
- Reaching `maxItems` or the budget pauses the job with `error: "budget_exhausted"`; until the caller raises it with a
  PUT, `POST /jobs/{id}/resume` answers 409 `BUDGET_EXHAUSTED`. Expiry pauses jobs with `principal_expired`, a
  withdrawn provider or instrument grant with `grant_withdrawn`; each resumes explicitly once its cause is gone. An item
  refused at admission was never dispatched: it settles `paused` with the refusal's code and no receipt.
- A daemon shutdown or crash pauses nothing. Admission stops, calls in flight are aborted and their items return to the
  queue unsettled (each aborted call keeps its transport receipt but has no `broker.receipt` event), and the job keeps
  its state. The next start relaunches it under the same job id while the principal still admits it (grants, budget,
  expiry, unchanged worker configuration); otherwise it waits as `interrupted` for an explicit resume. Every item
  therefore settles, and is reported, exactly once per job.
- `POST /jobs/{id}/resume` continues a job's unfinished items as a new job of its lineage. Resuming a job that was
  resumed before answers that earlier resume's job and changes nothing else, so a client may walk a long lineage to its
  tail without letting other work into a provider that is still limited. A job whose worker configuration changed since
  it was submitted cannot resume into a new job (409 `WORKER_CONFIG_CHANGED`); submit it again under another
  idempotency key. A submission whose idempotency key already holds other work answers 409 `WORKER_KEY_CONFLICT` with
  the `jobId` of that job, always one of the caller's own.

### The socket is the identity

- `socket: true` opens `<data-dir>/principals/<random>/broker.sock`: the directory is `0700`, the socket `0600`, and
  `principals.sqlite` (records, usage, counted items, audit) lies next to them. All daemon processes run as one user, so
  the permissions separate sandboxes, which must not mount the data directory, not unsandboxed processes of that user.
- The socket serves the turn socket's worker routes for the principal's own jobs only: `GET /configs`,
  `POST /bulk/submit`, `GET /jobs`, `GET /jobs/{id}`, `GET /jobs/{id}/results` and `POST /jobs/{id}/cancel|resume`,
  with `?view=summary` where the turn socket has it. `GET /configs` returns `authorization` (`principalId`, also as
  `attemptId`, `runId`, `state`, `instruments`, and `publicLiteratureAllowed`, true for an active run principal), the
  principal's grants and usage, `instrumentMode: 1` and `instrumentVerbatim: 1` with the installed instruments it is
  granted, verbatim ones included, and one bulk worker per granted, configured provider, whose `id` is the provider id.
  Its `revision` changes only when that worker list changes, never on budget changes. Agent jobs, native model routes,
  proxying and `CONNECT` are refused. No header, body field or environment variable names a principal.
- Principals and sockets persist: a restart reopens each socket at the same path in the same directory, after broker
  recovery has requeued the jobs that were running, so no job can be submitted while recovery would still launch it.
- Revocation, or a PUT with `socket: false`, removes the socket and its directory, so a bound sandbox then reaches
  nothing.

### Binding a principal socket into a sandbox

A sandbox launcher that gives a process its principal socket should:

- bind the principal's directory read-only, not the socket file, so the socket a restart re-creates stays reachable;
- validate the directory first: inside the daemon's data directory, owned by the daemon user, mode `0700`, not a
  symlink, with a `0600` socket inside.

`POST /compute/jobs` accepts `principalId` for this. The daemon refuses it unless that principal is unrevoked with an
open socket, and passes the binding only to the host-side launcher, in its controller environment:
`PUPPENCLAW_PRINCIPAL_ID`, `PUPPENCLAW_PRINCIPAL_SOCKET_DIR` and `PUPPENCLAW_PRINCIPAL_SOCKET`. The job's own
environment never carries it, and a job without `principalId` never gets one. `PUPPENCLAW_ORCHESTRATION_SOCKET` stays
the variable of an orchestrated session's socket.

### Jobs, usage and purge

Principal jobs live in `advanced.sqlite` like turn jobs, with `parentSessionName` `principal:<id>`, the principal id as
`attemptId`, and `principalId` and `runId` fields. Their usage reaches the caller through the broker receipts, not the
turn usage ledger. An account purge (`POST /sessions/owner/purge`) revokes the owner's principals with `cancel` before
it erases their jobs, and then reduces their records to tombstones: the id, kind, timestamps and revocation stay (the id
remains unusable); the owner key, run binding, grants, usage, counted items and audit go.

### Chat-turn bulk authority

`PUPPENCLAW_LEGACY_ATTEMPT_AUTHORITY` decides whether chat turns carry bulk authority:

- `on` (default, `features.legacyAttemptAuthority: 1`): a turn in `execute` mode with `approve-all` may submit bulk work
  over its turn socket and reports `publicLiteratureAllowed: true`.
- `off`: only principal sockets carry bulk authority. A turn socket answers bulk submissions with 409
  `PRINCIPAL_REQUIRED` and reports `publicLiteratureAllowed: false` and `bulkAvailable: false`. The egress deny list
  stays active in both modes: it only denies, never grants.
