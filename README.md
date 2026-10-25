# Puppenclaw

Puppenclaw is a native OpenClaw plugin that turns ACP-backed coding agents into a project-aware orchestration runtime.

Today it provides:

- named Claude Code or Codex ACP sessions
- project registration and context capture
- campaign templates for baseline work, literature review, ablations, self-improvement loops, and Codex-vs-Claude fusion runs
- artifact capture and approval gates
- optional daemon mode
- `oc2oc`-aware remote control paths for mediated delegation between OpenClaw peers

Puppenclaw does **not** yet implement a full typed orchestration transport inside `oc2oc`. The current `oc2oc` integration is conversation-mediated: remote assistants can delegate into Puppenclaw through bound and exposed `oc2oc` conversations, and Puppenclaw then runs work locally on the target node.

## What Works Now

- Local orchestration on one OpenClaw instance
- Daemon-backed orchestration over the local HTTP daemon
- Claude Code / Codex ACP session management
- Project context sync into reusable bundles
- Campaign templates:
  - `literature_review`
  - `baseline_from_scratch`
  - `ablation_campaign`
  - `self_improvement_loop`
  - `puppenfusion`
  - `custom`
- Approval gating and resume
- Artifact listing and retention pruning
- Research-command delegation via `orchestration.gptResearcherCommand`
- `oc2oc`-mediated remote `/puppenclaw` command flow when the remote conversation is explicitly bound and exposed

## What This Repo Contains

This is a source repository.

Checked-in source:

- `index.ts`
- `src/**`
- `test/**`
- `skills/**`
- `scripts/sync-manifest.mts`
- `openclaw.plugin.json`

Generated at build time:

- `dist/**`

If you install from the repo path, run `npm run build` first. `dist/` is not meant to be committed.

## Prerequisites

- Node `>=22.13`
- npm
- an OpenClaw installation on the machine where the plugin will run
- working ACP adapter commands for the agents you plan to use

Default ACP adapter commands:

- Claude: `npx -y @agentclientprotocol/claude-agent-acp`
- Codex: `npx @zed-industries/codex-acp`

Puppenclaw does not log you into model providers for you. Make sure the ACP adapter you plan to use already works on that machine before blaming Puppenclaw.

## How Puppenclaw launches Codex and Claude

Puppenclaw launches ACP agents in two layers:

- `acpxCommand`
  - the outer ACP launcher binary
  - example: `/absolute/path/to/acpx`
- `agentCommands`
  - the actual ACP adapters that `acpx` runs
  - examples:
    - `npx @zed-industries/codex-acp`
    - `npx -y @agentclientprotocol/claude-agent-acp`

The execution path is:

```text
/puppenclaw start -> Puppenclaw -> acpx -> codex-acp or claude-agent-acp
```

Important:

- `acpxCommand` is not the agent adapter command
- `agentCommands` are not a replacement for `acpxCommand`
- the ACP adapters run inside the OpenClaw gateway/plugin host environment
- that means the adapter sees the gateway's `HOME`, `PATH`, and auth files unless you override them in `agentCommands`

Preferred setup:

- run OpenClaw/Puppenclaw in an isolated `HOME`
- seed the required Codex and Claude auth into that same `HOME`
- keep `agentCommands` as the normal ACP adapter commands

Local development fallback:

- wrap `agentCommands` with `env HOME=/home/your-user ...` if you intentionally want Puppenclaw to reuse your existing shell auth

Example local config:

```json
{
  "plugins": {
    "entries": {
      "puppenclaw": {
        "enabled": true,
        "config": {
          "backend": "local",
          "acpxCommand": "/absolute/path/to/acpx",
          "defaultAgent": "codex",
          "agentCommands": {
            "codex": "npx @zed-industries/codex-acp",
            "claude": "npx -y @agentclientprotocol/claude-agent-acp"
          }
        }
      }
    }
  }
}
```

Local development fallback example:

```json
{
  "plugins": {
    "entries": {
      "puppenclaw": {
        "enabled": true,
        "config": {
          "backend": "local",
          "acpxCommand": "/absolute/path/to/acpx",
          "agentCommands": {
            "codex": "env HOME=/home/your-user npx @zed-industries/codex-acp",
            "claude": "env HOME=/home/your-user npx -y @agentclientprotocol/claude-agent-acp"
          }
        }
      }
    }
  }
}
```

## Install From This Repo

From a clean checkout:

```bash
cd /absolute/path/to/puppenclaw
npm install
npm run build
openclaw plugins install /absolute/path/to/puppenclaw
```

Then restart the OpenClaw gateway.

This path is the one a later Codex session should use when bootstrapping from source.

In local plugin mode, Puppenclaw stores its runtime state under the OpenClaw plugin state directory for that gateway instance. It should not create or use a repo-local `orchestrator/` directory in the checkout.

## Install From a Packed Tarball

If you want a release-style artifact instead of installing from the repo path:

```bash
cd /absolute/path/to/puppenclaw
npm install
npm run build
npm pack
openclaw plugins install /absolute/path/to/puppenclaw/puppenclaw-openclaw-plugin-0.1.0.tgz
```

Use the actual tarball name produced by `npm pack`.

## Development Verification

```bash
cd /absolute/path/to/puppenclaw
npm install
npm run verify
```

That runs manifest sync, build, typecheck, and tests.

## Configuration

Configure Puppenclaw under `plugins.entries.puppenclaw.config`.

Minimal local mode:

```json
{
  "plugins": {
    "entries": {
      "puppenclaw": {
        "enabled": true,
        "config": {
          "backend": "local",
          "acpxCommand": "/absolute/path/to/acpx",
          "defaultAgent": "codex",
          "permissionMode": "approve-reads",
          "maxSessions": 5,
          "sessionTtlMinutes": 60,
          "streamOutput": true,
          "agentCommands": {
            "claude": "npx -y @agentclientprotocol/claude-agent-acp",
            "codex": "npx @zed-industries/codex-acp"
          },
          "mcpServers": {},
          "orchestration": {
            "enabled": true,
            "maxCampaigns": 32,
            "artifactRetentionHours": 336,
            "allowLocalCommandExecution": true,
            "defaultProjectRoot": "/absolute/path/to/workspaces",
            "localWorker": {
              "id": "local",
              "label": "Local Worker",
              "labels": ["local"],
              "projectRoots": ["/absolute/path/to/workspaces"]
            }
          },
          "remoteControl": {
            "mediated": {
              "enabled": true
            },
            "purePipe": {
              "enabled": false,
              "allowFrom": [],
              "allowedAgents": []
            },
            "requireConversationBinding": true
          }
        }
      }
    }
  }
}
```

Daemon mode:

```json
{
  "plugins": {
    "entries": {
      "puppenclaw": {
        "enabled": true,
        "config": {
          "backend": "daemon",
          "daemonUrl": "http://127.0.0.1:18795",
          "acpxCommand": "/absolute/path/to/acpx",
          "defaultAgent": "codex",
          "permissionMode": "approve-reads",
          "streamOutput": true,
          "agentCommands": {
            "claude": "npx -y @agentclientprotocol/claude-agent-acp",
            "codex": "npx @zed-industries/codex-acp"
          },
          "orchestration": {
            "enabled": true,
            "maxCampaigns": 32,
            "artifactRetentionHours": 336,
            "allowLocalCommandExecution": true,
            "defaultProjectRoot": "/absolute/path/to/workspaces",
            "localWorker": {
              "id": "local",
              "label": "Local Worker",
              "labels": ["local"],
              "projectRoots": ["/absolute/path/to/workspaces"]
            }
          }
        }
      }
    }
  }
}
```

For direct one-shot Codex providers, `approve-reads` runs `codex exec` with
`--sandbox read-only` and without the bypass flag. `approve-all` retains
`--dangerously-bypass-approvals-and-sandbox`; deployments should still confine that process with
their outer sandbox. Codex has no exact Puppenclaw `deny-all` process flag, so Puppenclaw uses the
read-only sandbox and adds explicit no-tool guidance to the prompt. That guidance is defense in
depth, not a hard no-read/no-tool boundary.

### Provider reasoning controls

Session start and follow-up requests accept an optional `effort` value. Puppenclaw resolves that
value against the selected provider rather than assuming that every backend uses the same scale:

| Provider profile | Canonical controls                               | Compatibility behavior                                                                                                            |
| ---------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code      | `low`, `medium`, `high`, `xhigh`, `max`          | Legacy `ultra` maps to `max`. `ultracode` requires a native workflow adapter exposing `ocsl_workflow_v1`; it uses xhigh plus real workflow orchestration, never a max alias. |
| Codex            | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | The selected tier is forwarded to the runtime.                                                                                    |
| GLM-5.2          | `none` (shown as Off), `high`, `max`             | `minimal` maps to Off; `low` and `medium` map to High; `xhigh`, `ultra`, and `ultracode` map to Max.                              |

GLM-5.2 is detected from its model identifier. For a relay that uses an opaque model name, set
`modelProvider.reasoningProfile` to `glm-5.2` explicitly.

Provider or model support still governs whether a forwarded setting is usable. In particular,
Claude Ultracode is not another name for Max. Puppenclaw exposes it in capability metadata but
marks it unavailable: the current ACP boundary cannot safely represent Ultracode's approval,
progress, background-run, and multiplexing lifecycle. A Claude Ultracode request therefore fails
clearly instead of silently substituting Max or a prompt instruction.

### Codex local subagent policy

A `codex-openai-compatible` model provider may carry an optional, strict
`modelProvider.subagents` object: `{ "model": "chat", "effort": "xhigh", "maxConcurrentThreads": 6 }`
(`maxConcurrentThreads` is an integer from 1 to 16). Other provider kinds reject it. The policy is
persisted with the session, copied by forks, replaced by a same-id provider refresh, and part of the
turn fingerprint only when present, so existing fingerprints stay unchanged.

With a policy, the one-shot Codex turn passes it to the provider wrapper as
`PUPPENCLAW_MODEL_PROVIDER_SUBAGENT_MODEL`, `PUPPENCLAW_MODEL_PROVIDER_SUBAGENT_EFFORT` and
`PUPPENCLAW_MODEL_PROVIDER_SUBAGENT_MAX_THREADS`, and passes the main turn's resolved effort as
`PUPPENCLAW_MODEL_PROVIDER_REASONING_EFFORT`. It omits the `-m` and `-c model_reasoning_effort`
CLI overrides, because the wrapper writes the main model and effort into `config.toml` next to the
pinned subagent roles. A session model that differs from the provider's model fails with
`MODEL_PROVIDER_SUBAGENT_POLICY_CONFLICT`. Without a policy, arguments and environment are
unchanged, and the daemon never forwards these variables from its own environment. Daemons that
support the policy advertise `codexLocalSubagents: { "version": 1, "modelProviderField": "subagents",
"cliModelOverrides": false }` on `GET /capabilities`; clients should send `subagents` only then,
because older daemons reject the unknown field.

### Config Notes

- `backend`
  - `local`: plugin process talks to ACP adapters directly
  - `daemon`: plugin talks to a standalone Puppenclaw HTTP daemon
- `acpxCommand`
  - path or command used to start the ACP launcher
  - Puppenclaw calls this first, then passes the selected adapter command through it
- `agentCommands`
  - per-agent ACP adapter commands
  - use wrapper commands here when adapter auth must come from a different `HOME`
- `orchestration.maxCampaigns`
  - maximum number of active campaigns in `draft`, `running`, or `waiting_approval`
- `orchestration.artifactRetentionHours`
  - old artifacts are pruned on runtime access
- `orchestration.defaultProjectRoot`
  - base directory used to resolve relative `project.rootDir` values
- `orchestration.allowLocalCommandExecution`
  - required for `command` steps and built-in evaluation/experiment commands
- `orchestration.gptResearcherCommand`
  - optional shell command for `research` steps
  - Puppenclaw sends the step prompt to stdin
  - Puppenclaw expects dossier text on stdout
  - environment variables exposed:
    - `PUPPENCLAW_PROJECT_ID`
    - `PUPPENCLAW_PROJECT_NAME`
    - `PUPPENCLAW_PROJECT_ROOT`
    - `PUPPENCLAW_CAMPAIGN_ID`
    - `PUPPENCLAW_CAMPAIGN_NAME`
    - `PUPPENCLAW_STEP_ID`
    - `PUPPENCLAW_STEP_TITLE`
    - `PUPPENCLAW_TASK`

Example research-command config:

```json
{
  "plugins": {
    "entries": {
      "puppenclaw": {
        "enabled": true,
        "config": {
          "backend": "local",
          "orchestration": {
            "gptResearcherCommand": "python /absolute/path/to/research-wrapper.py"
          }
        }
      }
    }
  }
}
```

## Running the Daemon

If you use `backend: "daemon"`, start the daemon separately after the repo is built:

```bash
cd /absolute/path/to/puppenclaw
npm run build
node dist/daemon/cli.js start --host 127.0.0.1 --port 18795 --data-dir /absolute/path/to/puppenclaw-state
```

Check health:

```bash
node dist/daemon/cli.js status --host 127.0.0.1 --port 18795
```

Stop it:

```bash
node dist/daemon/cli.js stop --host 127.0.0.1 --port 18795
```

SIGTERM and SIGINT close the daemon: it stops accepting requests, ends
connections still open after 2 s, closes its stores and releases the state owner
lease, then exits 0. A second signal, a failing close, or a close that outlasts
`PUPPENCLAW_SHUTDOWN_TIMEOUT_MS` (default 20000) exits 1 at once. Runner process
groups are detached and keep running; see the boot reaper below.

### pcp/2 identity, health and opt-in compact shapes

Every response carries the headers `x-puppenclaw-protocol` (`2.0`),
`x-puppenclaw-boot-id` (new on every start) and `x-puppenclaw-spool-id` (the
identity of the persisted in-flight state in `spool.json`; it changes only when
that state is replaced: a fresh data directory, unreadable state, or a recovery
reset). The routes below require the bearer token whenever `daemonAuthToken` is
set; none of them is added to the open `/health` and `/capabilities`.

- `GET /v2/health`: constant-cost and under 1 KB: `ok`, `protocol`, `bootId`,
  `spoolId`, `build` (`PUPPENCLAW_BUILD_ID` or version plus bundle digest),
  `activeTurns`, `backlog` (open streams, queued stream events and bytes,
  pending state writes), `eventLoop` (`monitorEventLoopDelay` p99 and max lag in
  ms over a 30 s window) and `memory`.
- `GET /v2/capabilities`: `features` (`health`, `opsIdle`, `usageLedger`,
  `compactStatus`, `keyedStreaming`, `sseGap`, and the broker's `eventFeed`,
  `brokerOutbox` and `instrumentMode` described below), `limits`, and provider
  dialect limits, e.g. the structured-output keywords removed for `qwen-3.8`.
- `GET /ops/idle`: counts only, each measured at request time (active turns,
  turn and runner processes, running turn keys, active and paused broker jobs,
  active compute jobs, open streams). Restart survivors count only while their
  processes may still be alive: `recoveryFencedSessions` (sessions fenced after a
  restart whose recorded process is not proven gone; the next dispatch clears
  the fence once it is) and `leftoverRunnerGroups` (runner groups of earlier
  boots still running). `recoveryFencesWithoutProcess` counts fences that record
  no process (missing turn metadata or pid): there is nothing to wait for, but
  such a session refuses new turns (`RECOVERY_FENCE_ACTIVE`) until it is stopped.
- `GET /session/:name?view=summary` and `GET /sessions?view=summary`: the
  session without its transcript (plus `transcriptSummary`) and without the
  `acpx status` probe. Where a reader needs the runtime to classify one session,
  its summary carries it like the full view: `runtime.status: quiesced` for a
  quiesced session (no probe), and the probe's result for a session stored as
  `running` without an active turn (a stale record that only the runtime can
  show is over). `transcriptLimit=N` (0–1000) keeps the newest N entries
  in either view. `GET /session/:name/output` takes the same two options: its
  latest output stays, its session snapshot is compacted the same way.
- `GET /session/:name/transcript?after=SEQ&limit=N` (1–500, about 1 MB per page):
  entries with `seq`, `total`, `next`, `hasMore`, and the session `generation`.
- `GET /usage/ledger?afterId=SEQ&limit=N` (1–1000): ledger rows in insertion
  order with `seq`, `next`, `hasMore`, `head` and a stable `ledgerId`; `afterId`
  also accepts a ledger row id. An unknown row id or a seq beyond `head` (a
  cursor of another copy of the ledger) is refused with 400
  `INVALID_LEDGER_CURSOR`; read the ledger from its start then.
- `POST /session/start` and `POST /session/:name/send` (and their `/stream`
  variants) accept `"resultView": "turn"`: the result holds this turn's output
  and signals and the same compact session snapshot a keyed replay returns,
  never the transcript. On the stream routes, `"keyedStreaming": true` lets a
  keyed turn stream its own live output with the same event sequence as an
  unkeyed turn; a repeated request for a running key joins its remaining output,
  and replays or rejected requests never see another turn's output. These
  options are not part of the turn fingerprint.

Without these options every route answers exactly as before. Opted-in bodies
also carry `protocol`, `bootId` and `spoolId`.

Each SSE stream writes straight through while the client reads. When the client
falls behind, events wait in that stream's queue and chunks are coalesced; above
`PUPPENCLAW_SSE_MAX_PENDING_BYTES` (default 8 MiB) further `chunk` and
`activity` events are dropped and replaced by one `gap` event with
`droppedEvents` and `droppedBytes`. `final`, `question`, `complete`, `error`,
`result` and `done` are never dropped. A stalled client never slows the runner.

Live-turn progress is checkpointed for all turns together every
`PUPPENCLAW_ACTIVE_TURN_CHECKPOINT_MS` (default 30000), and session state
writes are group-committed; status reads report the live values.

Every detached runner group is recorded under `<data-dir>/runners`.
`PUPPENCLAW_BOOT_REAPER` decides what the next start does with groups a
crashed daemon left behind: `observe` (default) logs and counts them, `on`
terminates those whose leader is provably the recorded process (SIGTERM, then
SIGKILL) and asks their acpx runtimes to cancel the interrupted prompt, and
`off` keeps no records. A group whose leader is gone is never signalled, and
neither is one recorded during an earlier host boot (each record carries the
kernel boot id; pids and start ticks restart at boot): its record is removed.
`node --experimental-strip-types scripts/measure-h4.mts` measures health cost,
state writes, event-loop lag and stalled-stream memory against a built daemon.

### pcp/2 broker feed and instrument mode

The advanced broker reports to coscila through an acknowledged event feed and
runs measurement instruments that coscila installs. `GET /v2/capabilities`
advertises each part under `features`: `eventFeed: 1`, `brokerOutbox: 1` and
`instrumentMode: 1` (limits `eventPageMax`, `eventWaitMsMax`,
`eventInlineOutputMax`). The routes need the bearer token like every v2 route,
and every body carries `protocol`, `bootId` and `spoolId`; errors add `code`,
`retryable` and `error`.

**Outbox.** `advanced.sqlite` holds an outbox table (`seq INTEGER PRIMARY KEY
AUTOINCREMENT, type, job_id, item_id, payload, created_at`). Every job creation
and job state change writes a `broker.job` row, and every item that settles
after a provider call writes one `broker.receipt` row, in the same transaction
as the change itself: a crash keeps the change and its row together or loses
both. An item gets at most one receipt row per job; a duplicate completion is
refused. Seqs only grow and are never reused, also after pruning; gaps can only
appear at or below the acknowledged cursor (retention, erasure).

- `GET /v2/events?after=SEQ&limit=N&waitMs=MS` (`after` default 0, `limit`
  1-1000, default 500, `waitMs` 0-25000): `{ok, feedId, events: [{seq, type,
  at, jobId, itemId?, payload}], next, hasMore, head, acked}` in seq order. With
  `waitMs` the request returns as soon as an event after `after` commits, or
  empty when the wait ends. `after` beyond `head` is refused with 400
  `INVALID_EVENT_CURSOR`: the cursor belongs to another outbox, read from 0.
  Events are fsynced before they are served, so a served seq survives power
  loss. `feedId` is stored with the outbox and changes only when
  `advanced.sqlite` is replaced; then restart from 0 (ids make that idempotent).
- `POST /v2/events/ack {feedId, through}`: `{ok, acked}`, durable, never moves
  backwards (an older `through` returns the current value). Another `feedId` is
  refused with 409 `FEED_REPLACED`; a `through` beyond `head` with 400
  `INVALID_EVENT_CURSOR`.
- `broker.job` payload: `{jobId, ownerKey, principalId, runId, state, counts:
  {total, queued, running, succeeded, failed, cancelled, truncated},
  instrumentDigest, createdAt, updatedAt}` (absent values are null). Counts
  fold item states into these categories: paused and interrupted items count as
  failed (a resume runs them in a new job), a truncated item counts once, as
  truncated.
- `broker.receipt` payload: `{jobId, itemId, attempt, status
  (succeeded|failed|truncated|cancelled), finishReason, usage: {input, output,
  cacheRead, cacheWrite}, model, serverFingerprint, settingsSha256,
  instrumentDigest, outputDigest, outputBytes, output, startedAt, endedAt,
  error: {code, retryable} | null}`. `output` is inline only up to 16384 UTF-8
  bytes; larger outputs stay in the job's result pages. `outputDigest` is the
  sha256 of the output as a string, or of its compact JSON when it is
  structured. Agent jobs report their single item over all its native calls.
- Erasure never runs ahead of the feed: purging a session (or an owner) keeps
  the rows of every job that still has unacknowledged events and completes
  their erasure when the acknowledgement covers them. Acknowledged rows of an
  erased job go with it.
- Retention is opt-in: `PUPPENCLAW_EVENT_RETENTION_DAYS` (at least 7) prunes
  acknowledged rows older than that, hourly. Unacknowledged rows are never
  pruned.

**Receipt provenance.** Every broker receipt (bulk, retried attempt, native
controller or agent call) carries `serverFingerprint`: the upstream's
`system_fingerprint` when it sends one, otherwise `<served model>@<16 hex>`
where the hex starts the sha256 of the canonical JSON of the server identity
headers present (`server`, `via`, `x-powered-by`, `openai-version`); it is never
empty. `settingsSha256` is the sha256 of the canonical JSON (keys sorted by code
point, no whitespace, numbers as JSON.stringify writes them) of exactly
`{model, temperature, seed, reasoning, max_tokens, response_format_sha256,
system_prompt_sha256}` as sent, missing values null.

**Instruments.** `PUT /v2/instruments/{digest}` with `{instrumentId, version,
systemPrompt, responseSchema|null, maxOutputTokens: {perItem, minimum},
temperature, seed|null, reasoning, itemsPerCall, requiredModelFingerprint|null}`
installs a bundle and answers `{ok, digest, settingsSha256}`; the same body again
returns the same answer, a different body under an installed digest is refused
with 409 `INSTRUMENT_DIGEST_CONFLICT`, an invalid one with 400
`INVALID_INSTRUMENT`. The digest is opaque (1-128 characters of
`[A-Za-z0-9._:-]`): coscila's instrument registry computes it
(ocsl-instrument-digest-v1) and the daemon only allow-lists what was
installed. `GET /v2/instruments` lists `digests` and `instruments`. The
allow-list lives in `advanced.sqlite` and survives restarts. The PUT's
`settingsSha256` digests the installed settings (system prompt as sent,
response schema, sampling, the output-token rule, items per call, required
fingerprint); each receipt's `settingsSha256` digests one call.

A bulk job naming `instrumentDigest` (socket `POST /bulk/submit`) runs in
instrument mode; a digest that is not installed is refused with 400
`INSTRUMENT_NOT_ALLOWED`, and a job `schema` next to it with 400
`INSTRUMENT_REQUEST_CONFLICT`. Each item is a string or `{messages, itemCount}`:
messages (user and assistant roles) are sent verbatim after the system prompt,
which is the broker's worker policy, a blank line and the instrument's
`systemPrompt`. Per call, `max_output_tokens = max(minimum, perItem ×
itemCount)` (`itemCount` defaults to `itemsPerCall`, 1 for a string), and
temperature, seed, reasoning effort and the response schema come from the
bundle; an item that tries to set any of them fails with `INVALID_REQUEST`.
`finish_reason=length` (Responses `status: incomplete` with
`max_output_tokens`) marks the item `truncated: true`: a text output is kept, a
cut structured output fails `STRUCTURED_OUTPUT_INVALID`, and the receipt's
status is `truncated` either way. With `requiredModelFingerprint`, an answer
whose fingerprint and served model both differ pauses the job (`MODEL_DRIFT`)
and keeps no output. The socket's `GET /configs` lists installed instruments.

**Provider pauses and retries.** HTTP 429 and authentication failures (401,
403) pause the provider for the attempt at once; a 503 does so only after the
last retry. The paused job carries `resumeAfter` (ISO time) from `Retry-After`
or, without it, the latest provider reset header (`x-ratelimit-reset-*`,
`anthropic-ratelimit-*-reset`, `ratelimit-reset`); job listings and summaries
show it. Retries use exponential backoff from `PUPPENCLAW_BULK_RETRY_BASE_MS`
(default 1000, ±20 % jitter, at most 30 s).

**Direct upstreams.** Tool-free bulk calls can bypass a local compatibility
proxy: `PUPPENCLAW_BULK_DIRECT_UPSTREAMS` maps a registered provider base URL to
the upstream behind it, for example
`{"http://127.0.0.1:18160/v1":"http://upstream:18000/v1"}`. Those calls share
one keep-alive connection pool per upstream and capacity group, sized to the
group's concurrency limit, and are shaped exactly as the namespace proxy
forwards a tool-free Responses request (its turn-policy markers, agent-message
conversion, replayed-call repair and four-image limit); the model and all other
fields pass unchanged. Agents keep using the registered URL. The mapped
upstreams join the sandbox egress deny list.

**Store.** Writes are group-committed: a batch commits as one transaction
within `PUPPENCLAW_ADVANCED_COMMIT_WINDOW_MS` (0-50, default 50), and a batch
that fails is replayed write by write so only the failing write is lost. Every
read first commits pending writes. A running item lives in memory only; a job
header changes with the job state, and item progress only moves its revision
(at most once per batch) and its `updatedAt` (at most once a second). Owner,
child-session and state lookups use expression indexes instead of full scans.
Statistics and the usage ledger receive bulk receipt updates in batches (newest
state per call, at most once a second, always before a parent turn's statistics
settle). On restart, bulk jobs written by this version are requeued: their
unsettled items return to `queued` and the job waits for an explicit resume
(`interrupted`) unless its authority survives the restart, which only a run
principal's does (see "pcp/2 run principals"): such a job relaunches under its
own job id. Jobs written before this version and agent jobs are interrupted as
before.

Rollback: an older daemon (c36cfa2, cea4c29) opens a store written by this
version and reads and writes it; it ignores the new tables. It cannot resume
jobs whose inputs live only in blobs, and it writes no outbox rows: when this
version reopens the store it emits the current state of every job, and the
receipt of every item, that the older daemon changed. A job header the older
daemon rewrote counts as written before this version from then on.

`PUPPENCLAW_ADVANCED_ARCHIVE_DAYS` (at least 30; off by default) archives, once
a day, terminal jobs last updated earlier than that into
`<data-dir>/advanced/archive/advanced-archive-<time>.sqlite` with inputs
materialized and a manifest of counts and sha256 per job; the live rows go only
after both copies agree. Jobs with a study reference (`study_ref`),
unacknowledged events or a pending erasure stay.

`node --experimental-strip-types scripts/measure-p1.mts` measures bulk
completions per second and event-loop lag against a mock upstream, with the
daemon's statistics and usage-ledger hooks.

### pcp/2 run principals (`principals:1`)

A principal is bulk authority that the caller grants and the daemon enforces:
a study run (`kind: "run"`, bound to its `runId`) or, later, a person
(`kind: "human"`, stored now, no credential logic yet). `/v2/capabilities`
advertises `features.principals: 1` only when `daemonAuthToken` is set; without
it the routes answer 503 `DAEMON_AUTH_REQUIRED`. Every response, errors included,
carries `protocol`, `bootId` and `spoolId`. Ids are 1–128 characters of
`A-Za-z0-9._:-`.

- `PUT /v2/principals/{id}` with `{kind, runId, ownerKey, grants: {providers,
  instruments, maxConcurrency, maxItems, tokenBudget: {input, output},
  expiresAt}, socket}` returns `{ok, protocol, bootId, spoolId, principalId,
  kind, runId, grants, socketPath, createdAt, updatedAt}`. The same body returns
  the same result. Changed grants or a changed `socket` take effect at once and
  are audited. `kind`, `runId` and `ownerKey` never change (409
  `PRINCIPAL_CONFLICT`), and a revoked id stays revoked (409 `PRINCIPAL_REVOKED`).
  No response ever contains `ownerKey`.
- `GET /v2/principals/{id}` adds `state` (`active`, `expired`, `revoked`),
  `revokedAt`, `revision`, `usage` (admitted `items`, settled `inputTokens` and
  `outputTokens`, `activeItems`, `remaining`), `providersUnavailable` and the last
  50 audit entries.
- `DELETE /v2/principals/{id}[?cancel=1]` returns `{ok, principalId, revokedAt}`
  and is idempotent. Before it returns, the principal's socket is gone and no
  further item is admitted (the contract allows 5 s; the test measures a few
  ms). Items already dispatching finish, or abort with `cancel=1`. Every item
  the principal had not admitted ends `cancelled`. A revocation that a restart
  interrupted completes at the next start. Revocation stays possible while
  session state awaits an operator reset; PUT does not.

Grants:

- `providers` name entries of `PUPPENCLAW_MODEL_PROVIDERS`, a JSON array of
  model provider configurations (the shape of a turn's `modelProvider`). It is
  the only source of a principal provider's endpoint, model and credential
  variable; `authTokenEnv` names a variable of the daemon environment, never a
  secret. A socket client can never choose one. Unset means no provider for
  principals; an invalid value fails startup.
- `instruments` are opaque digests. A principal with instrument grants may submit
  only jobs that name one of them (403 `INSTRUMENT_REQUIRED`, 403
  `INSTRUMENT_NOT_GRANTED`), and a granted digest must also be installed through
  `PUT /v2/instruments/{digest}` (400 `INSTRUMENT_NOT_ALLOWED`): grants restrict
  which installed instruments a principal's jobs may run, never widen the
  allow-list.
- `maxConcurrency` bounds the dispatching items of all the principal's jobs
  together. The principal's slot is taken before provider capacity, so a
  principal at its limit holds no provider permit.
- `maxItems` caps the items the principal admits over its lifetime, exactly.
  `tokenBudget` caps the settled input tokens (every prompt token the provider
  reports, cached ones included) and output tokens. Calls already dispatching,
  at most `maxConcurrency` of them, can overshoot a token budget. Reaching either
  pauses the job with `error: "budget_exhausted"`. The budget refills only when
  the caller raises it with a PUT; until then `POST /jobs/{id}/resume` on the
  socket answers 409 `BUDGET_EXHAUSTED`, afterwards it continues the remaining
  items as a new job.
- Expiry pauses jobs with `principal_expired` and a withdrawn provider or
  instrument grant with `grant_withdrawn`; each resumes explicitly once its cause
  is gone. An item refused at admission was never dispatched: it settles
  `paused` with the refusal's code (for example `BUDGET_EXHAUSTED`) and no receipt.
- A daemon shutdown or crash pauses nothing. Admission stops, calls in flight are
  aborted and their items return to the queue unsettled (each aborted call keeps
  its transport receipt, but no `broker.receipt` event), and the job keeps its
  state. The next start requeues it and relaunches it under the same job id while
  its principal is live and still admits it (grants, budget, expiry, unchanged
  worker configuration); otherwise it waits as `interrupted` for an explicit
  resume. Every item therefore settles, and is reported, exactly once per job.

The socket is the identity:

- `socket: true` opens `<data-dir>/principals/<random>/broker.sock`: the
  directory is 0700, the socket 0600, and `principals.sqlite` (records, usage,
  audit) lies next to them. The data directory is inside the daemon state root
  (`PUPPENCLAW_STATE_ROOT`), which the lab sandbox policy hides from every
  sandbox and never binds. All lab and daemon processes share one user, so this
  separates sandboxes, not unsandboxed processes.
- The socket serves the turn socket's worker routes for the principal's own jobs
  only: `GET /configs`, `POST /bulk/submit`, `GET /jobs`, `GET /jobs/{id}`,
  `GET /jobs/{id}/results` and `POST /jobs/{id}/cancel|resume`, all with
  `?view=summary` where the turn socket has it. `GET /configs` returns
  `authorization.principalId` (also as `attemptId`), `runId`, `state`,
  `instruments` and `publicLiteratureAllowed` (true for an active run principal),
  the principal's grants and usage, `instrumentMode: 1` with `instruments` (the
  installed instruments it is granted, in the turn socket's shape), and one bulk
  worker per granted, configured provider, whose `id` is the provider id. Its
  `revision` changes only when that worker list changes, never on budget changes.
  Agent workers, native model routes, proxying and CONNECT are refused. No
  header, body field or environment variable names a principal.
- Principals and sockets persist: a restart reopens each socket at the same path
  in the same directory; only the socket file is replaced.

How a sandbox gets its principal socket (the lab launcher does this; plan R5/E4):

- Bind the principal's directory read-only, for example
  `--ro-bind <dir> /run/ocsl/principal`, and point the client at
  `/run/ocsl/principal/broker.sock` (coscila-review reads
  `PUPPENCLAW_ORCHESTRATION_SOCKET`). Bind the directory, not the socket file, so
  the socket a restart re-creates stays reachable. Validate the directory first:
  inside the state root, owned by the daemon user, mode 0700, not a symlink, a
  0600 socket inside.
- `POST /compute/jobs` accepts `principalId`. The daemon refuses it unless that
  principal is live with an open socket, and passes the binding only to the
  host-side launcher, in its controller environment: `PUPPENCLAW_PRINCIPAL_ID`,
  `PUPPENCLAW_PRINCIPAL_SOCKET_DIR` and `PUPPENCLAW_PRINCIPAL_SOCKET`. The job's
  own environment never carries it, and a job without `principalId` never gets
  one.
- Revocation, or a PUT with `socket: false`, removes the socket and its
  directory, so a bound sandbox then reaches nothing.

Principal jobs live in `advanced.sqlite` like turn jobs, with
`parentSessionName` `principal:<id>`, the principal id as `attemptId`, and
`principalId` and `runId` fields. Their usage reaches the caller through the
broker receipts, not the turn usage ledger. An account purge
(`/sessions/owner/purge`) revokes the owner's principals with `cancel` before
it erases their jobs. Daemons from before principals never open
`principals.sqlite` and read the added job fields unchanged.

`PUPPENCLAW_LEGACY_ATTEMPT_AUTHORITY` keeps today's turn authority:

- `on` (the default, `features.legacyAttemptAuthority: 1`): a turn in execute and
  approve-all mode may submit bulk work over its turn socket and reports
  `publicLiteratureAllowed: true`, as before.
- `off`: only principal sockets carry bulk authority. A turn socket answers bulk
  submissions with 409 `PRINCIPAL_REQUIRED` and reports
  `publicLiteratureAllowed: false` and `bulkAvailable: false`. Turn processes
  still receive `PUPPENCLAW_ORCHESTRATION_ATTEMPT_ID` as an identifier, because
  the deployed sandbox wrappers validate it, but it grants nothing. The egress
  deny list built from endpoint-like variable names stays active in both modes:
  it only denies, never grants.
- Any other value fails startup.


Advanced worker jobs store each result in its own SQLite row and each distinct
input once, as a blob keyed by the sha256 of its JSON (a resumed job reuses the
inputs of its predecessor). Existing job records migrate transactionally at
startup; completed items and idempotency keys survive the migration. Back up the
daemon state before updating it. See "pcp/2 broker feed and instrument mode"
above for the store's group commit, recovery and rollback behaviour.

For large runs, use `GET /orchestration/jobs?session=NAME&view=summary&after=0&limit=100`
and `GET /orchestration/jobs/JOB/results?session=NAME&after=0&limit=100`. The scoped
worker socket exposes the same routes without the `/orchestration` prefix or
`session` parameter. A single job also supports `GET /jobs/JOB?view=summary`;
submission routes accept `?view=summary`. Legacy routes retain full responses.
Summary pages omit prompts and results; result pages contain the latest state of
each changed item. Both return a durable numeric `nextCursor` and `hasMore`.
Limits are 1–1000. Consumers upsert by job/item id, retain the returned cursor, and
continue until `hasMore` is false. An item updated between pages can appear again;
these pages are a changed-state feed, not an event log. Export settled jobs for a
stable complete result set. Summary polling does not acknowledge results or
suppress the managed continuation. Reading the final results page acknowledges
a settled job; legacy full-result reads retain that behavior. Health metadata
reads never hydrate item contents.

Bulk dispatch shares a provider-wide concurrency limit across jobs and sessions
in this daemon. `PUPPENCLAW_BULK_PROVIDER_CONCURRENCY` sets the default (60);
`PUPPENCLAW_BULK_PROVIDER_LIMITS` accepts per-provider overrides, for example
`{"remote_qwen38_xhigh":40}`. Values may be any positive safe integer. Configured
worker listings report the effective `bulkConcurrencyLimit`. This bounds bulk
inference only; it does not cap native controller requests. Cancellation drains
queued leases as well as active requests. Chunk submissions below the existing
64 MiB request limit and keep scientific checkpoints in the workspace database.
A browser reconnect does not replace the approved worker attempt; explicit stop
and actual attempt closure still cancel its work. Interrupted jobs need explicit
resume, which retains completed items.

Profiles that address the same physical backend must share a capacity group.
The operator configures `PUPPENCLAW_BULK_PROVIDER_GROUPS` as a JSON mapping of
provider IDs to group names, for example:

```json
{"remote_qwen38_none":"qwen38","remote_qwen38_low":"qwen38","remote_qwen38_medium":"qwen38","remote_qwen38_xhigh":"qwen38"}
```

Each group uses the lowest effective member limit (including the default for
members without an override). `PUPPENCLAW_BULK_GROUP_LIMITS`, for example
`{"qwen38":60}`, explicitly overrides that group limit. Unmapped providers keep
their existing independent limits. Mappings are flat names, not recursive
aliases; a group and an ungrouped provider with the same name remain independent.
Invalid mappings and limits for groups without members fail startup. Changes
take effect when the daemon restarts. Provider identity, reasoning settings,
receipts and per-attempt quota pauses remain unchanged. Each study should also
enforce its own aggregate budget across all worker roles.

The worker `configs` response also reports provider-wide `capacity` with each
provider's `limit`, admitted `active` calls, and `waiting` requests. Grouped
providers include `capacityGroup` and report the same shared counters; do not
sum those duplicate counters. This metadata is outside the pinned scientific
worker configurations. A job item
can be running while waiting for a permit; it is not evidence of an upstream
inference slot. Bulk responses use a separate transport with a 30-minute total
deadline after admission, covering both headers and body. Set
`PUPPENCLAW_BULK_RESPONSE_TIMEOUT_MS` to a positive integer up to 86400000
(24 hours) to tune that deadline. Expiry records `BULK_RESPONSE_TIMEOUT`;
cancellation remains immediate and native controller transport is unchanged.
This removes the default five-minute header timeout. A bulk call that times out,
meets a connection reset or gets HTTP 502/503/504 is retried with backoff
(`PUPPENCLAW_BULK_RETRY_ATTEMPTS`, default 3); every attempt keeps its own
receipt and the item settles once.

Worker configurations and submitted job counts have no fixed numeric ceiling;
reuse a configuration across as many tasks as required. Requested bulk concurrency
is still bounded by the configured provider-wide capacity. Persistent native
harnesses use the separate positive-integer `maxSessions` admission setting
(default 5), without a hardcoded 100-session ceiling. Idle unfocused sessions may
be suspended to admit new work; retained history and one-shot Codex sessions do
not consume that capacity. If every persistent slot is active or focused, further
native admission returns `MAX_SESSIONS_REACHED`; it does not silently exceed the
configured limit or imply unlimited hardware or provider throughput.

The authenticated daemon API exposes a fenced lifecycle for callers that must
stop work or remove a session workspace without allowing a delayed dispatch to
reopen it:

1. `POST /session/:name/quiesce` durably fences new mutations, drains the
   active turn when one exists, closes the runtime, and returns a positive
   `details.quiescenceEpoch` with `details.runtimeClosed: true`.
   Quiescing an as-yet unknown session name is valid and fences a racing first
   start.
2. `POST /session/:name/purge` removes the tracked session while retaining an
   externally acquired fence.
3. An authenticated `POST /session/start` or `POST /session/:name/send` may
   resume work by supplying that exact positive `lifecycleEpoch`. Entering the
   turn atomically releases a matching active reservation. Once a session name
   has lifecycle history, every later start or send must carry its latest
   epoch; missing and stale epochs remain rejected even after release or daemon
   restart.
4. `POST /session/:name/quiesce/release` with `{ "epoch": <epoch> }` explicitly
   releases that exact fence without starting a turn. Repeated release of the
   latest epoch is idempotent; stale epochs are rejected and the per-name
   lifecycle history remains.

External epoch reservations and their latest epoch per session name are stored
independently from the session, so a daemon restart, purge, or retried cleanup
cannot silently reopen an externally fenced mutation window. Puppenclaw's own
purge and TTL-GC operations use transient reservations: they still fence
concurrent mutations and survive an interrupted purge, but do not create new
per-name lifecycle history or make an ordinary session name require an epoch.
An external quiescence request that encounters an interrupted transient purge
atomically adopts that reservation as the external lifecycle fence.
Session status reports an active external fence as stopped and its runtime as
`quiesced`. Legacy clients remain compatible for names that have no external
lifecycle history. `lifecycleEpoch` is confined to the authenticated daemon
boundary and is deliberately absent from the OpenClaw plugin command and tool
schemas. Capability discovery advertises these semantics under
`sessionQuiescence.version: 2`.

Account deletion can fence and clean every daemon session associated with an
opaque owner selector. The selector is accepted only when daemon bearer
authentication is configured and is never returned by session or cleanup
responses. Supply the same 16–128 character `ownerKey` on each authenticated
`POST /session/start` for the account. Then use
`POST /sessions/owner/list` with `{ "ownerKey": "..." }`, followed by
`POST /sessions/owner/quiesce` and `POST /sessions/owner/purge` with
`{ "ownerKey": "...", "operationKey": "...", "sessionNames": [...] }`. Reuse
one operation key for idempotent retries. `sessionNames` is an optional,
authoritative backfill for sessions created before owner selectors existed: the
daemon atomically binds only present, previously unowned sessions (or names it
already bound to that owner), rejects conflicting ownership, and fails closed
when absence cannot be proved by a durable prior binding. Owner claims survive
purge so retries can prove that a named legacy session was already removed. The
first cleanup call installs a durable account-wide creation fence; successful
purge is reported only after no owned session remains. Ambiguous survivors
return `OWNER_CLEANUP_INCOMPLETE` with
`recoveryRequired: true` while retaining the fence. Sessions created by legacy
callers without an owner selector remain unowned and must still be reconciled
or purged individually. Capability discovery advertises this contract under
`sessionOwnerCleanup.version: 1`.

## Conversation statistics

Controller-owned start/send requests can attach
`statisticsContext: { version: 1, chatId, attemptId }` when
`conversationStatistics.version === 1` is advertised. Requests without this
context are intentionally untracked; session names never infer attribution.
The context is included in durable request fingerprints, so replaying the same
turn key cannot charge an attempt twice. Agent-facing plugin tools cannot set it.

Authenticated `GET /statistics/turns?cursor=0&limit=100` returns a durable
`details` envelope with `daemonId`, `nextCursor`, `hasMore`, and latest-value
`turns`. Every checkpoint and settlement advances a global revision. Consumers
upsert by daemon and turn ID, never sum revisions, and rescan after a daemon ID
change. Recovery preserves the last checkpoint and marks interruption; it does
not extrapolate through downtime.

Runtime is monotonic active runner elapsed time, not summed child wall time.
Token input includes cache reads/writes; cache and reasoning counts are subsets,
not additions to total. Null means unobserved, never measured zero. Failed and
cancelled attempts retain observed partial usage. CPU uses cumulative kernel
counters for verified host process ancestry, baselines reused runtimes, excludes
managed compute trees, and is always labelled sampled partial coverage. It does
not measure remote model CPU/GPU use or reconstruct missed short-lived children.
Managed compute exposes its separately measured cumulative job-tree CPU.

Permanent chat deletion must call authenticated
`POST /statistics/chats/:chatId/purge` after verified runtime teardown. Its
`details` proof is `{ version: 1, chatId, purged: true, removedTurns }`.
Live attempts reject erasure. The operation is idempotent, keeps the global
revision monotonic, and fences delayed writes with a non-plaintext chat digest.
Ordinary session purge, model rotation, and TTL cleanup preserve statistics.

## OpenClaw Usage Surfaces

Puppenclaw exposes three main surfaces:

1. Agent tools

- `puppenclaw_project_create`
- `puppenclaw_worker_register`
- `puppenclaw_context_sync`
- `puppenclaw_campaign_start`
- `puppenclaw_campaign_status`
- `puppenclaw_artifacts`
- `puppenclaw_campaign_approve`
- `puppenclaw_campaign_cancel`
- `puppenclaw_reassessment_start`
- `puppenclaw_reassessment_status`
- `puppenclaw_reassessment_report`

2. Raw ACP session tools

- `puppenclaw_start`
- `puppenclaw_send`
- `puppenclaw_status`
- `puppenclaw_stop`
- `puppenclaw_resume`
- `puppenclaw_fork`
- `puppenclaw_cost`

3. `/puppenclaw` command

- mirrors the same behavior for deterministic command-style control

Gateway methods:

- `puppenclaw.projectCreate`
- `puppenclaw.workerRegister`
- `puppenclaw.contextSync`
- `puppenclaw.campaignRun`
- `puppenclaw.campaignStatus`
- `puppenclaw.artifacts`
- `puppenclaw.campaignApprove`
- `puppenclaw.campaignCancel`
- `puppenclaw.reassessmentStart`
- `puppenclaw.reassessmentStatus`
- `puppenclaw.reassessmentReport`

## Quick Start: Local Orchestration

These are the exact steps a future Codex session can follow.

1. Create and install the plugin

```bash
cd /absolute/path/to/puppenclaw
npm install
npm run build
openclaw plugins install /absolute/path/to/puppenclaw
```

2. Restart the gateway

3. Configure the plugin in OpenClaw with at least:

- `backend`
- `defaultAgent`
- `agentCommands`
- `orchestration.defaultProjectRoot`

4. In an OpenClaw conversation, create the project

```text
/puppenclaw project {"name":"demo-project","rootDir":"demo-project","description":"Main repo"}
```

Because `rootDir` is relative here, Puppenclaw resolves it under `orchestration.defaultProjectRoot`.

5. Register or confirm the local worker

```text
/puppenclaw worker {"id":"local","label":"Local Worker","labels":["local"],"projectRoots":["/absolute/path/to/workspaces"]}
```

6. Sync context

```text
/puppenclaw sync {"projectId":"demo-project","includeFiles":["AGENTS.md","README.md"],"memoryText":"Use npm, run tests, keep code terse."}
```

7. Run a baseline campaign

```text
/puppenclaw campaign {"projectId":"demo-project","workerId":"local","name":"baseline","template":"baseline_from_scratch","task":"Implement the first working baseline for this repo.","evaluationCommand":"npm test"}
```

Or run a fusion campaign that gives Codex and Claude the same sealed input bundle, cross-reviews both outputs, and performs a final merge pass:

```text
/puppenclaw campaign {"projectId":"demo-project","workerId":"local","name":"fusion-pass","template":"puppenfusion","task":"Implement the feature end to end.","evaluationCommand":"npm test","fusionPreferredAgent":"codex"}
```

Or reassess older Puppenclaw, Codex, and Claude Code sessions with a newer model. Puppenclaw imports matching project history, creates a new branch/worktree, asks the target model to patch only concrete old-model mistakes, runs validation, and stores a report. The base branch is never merged automatically.

```text
/puppenclaw reassess {"projectId":"demo-project","workerId":"local","targetModel":"gpt-new","providers":["puppenclaw","codex","claude"],"validationCommand":"npm test"}
```

8. Inspect status

```text
/puppenclaw campaign-status {"projectId":"demo-project"}
```

9. Inspect artifacts

```text
/puppenclaw artifacts {"projectId":"demo-project"}
```

10. If the campaign paused for approval, resume it

```text
/puppenclaw approve {"campaignId":"camp-..."}
```

## Campaign Templates

### `literature_review`

Use for citation-conscious research or landscape mapping.

Behavior:

- by default, runs as an ACP `research` step
- if `orchestration.gptResearcherCommand` is configured, Puppenclaw runs that command instead and stores stdout as a `research-dossier` artifact

### `baseline_from_scratch`

Use for:

- plan
- implement
- optionally evaluate with `evaluationCommand`

### `ablation_campaign`

Use when you already know the concrete experiment commands.

Example:

```text
/puppenclaw campaign {"projectId":"demo-project","workerId":"local","name":"ablation-1","template":"ablation_campaign","task":"Compare prompt variants.","experimentCommands":["python run_a.py","python run_b.py"]}
```

### `self_improvement_loop`

Repeats:

- planning
- implementation
- optional evaluation
- review

Control loop size with `iterations`.

### `puppenfusion`

Use when you want both Codex and Claude to work from the same sealed project brief, then fuse the results into a stronger final implementation.

Behavior:

- requires a clean git worktree at campaign start
- creates separate local-only worktrees for the Codex candidate, the Claude candidate, and the final merged candidate
- gives both planning and implementation runs the same sealed bundle:
  - task
  - scope and non-scope
  - constraints
  - validation plan
  - synced project context
  - exact base commit
- runs a planning round first:
  - Codex produces a structured plan review
  - Claude produces a structured plan review
  - OpenClaw synthesizes one canonical fusion plan
- pauses for approval after the synthesized fusion plan and before implementation starts
- requires both implementation runs to emit a structured implementation memo
- records a structured candidate handoff artifact for each backend with commit and validation metadata
- runs fresh cross-review sessions:
  - Codex reviews the Claude candidate
  - Claude reviews the Codex candidate
- synthesizes a fusion dossier from both memos and both peer reviews
- optionally sends that dossier to an external arbiter command if configured
- attempts automatic local git integration first, without PRs or manual merging
- only falls back to one final resolver merge pass with the fixed `fusionPreferredAgent` when automatic integration reports a conflict or unresolved path

Use `fusionPreferredAgent` to choose which backend performs the final merge run. If omitted, Puppenclaw falls back to the project's `fusionPreferredAgent`, then `defaultAgent`, then the plugin default agent.

Example:

```text
/puppenclaw campaign {"projectId":"demo-project","workerId":"local","name":"feature-fusion","template":"puppenfusion","task":"Implement the feature end to end.","evaluationCommand":"npm test","fusionPreferredAgent":"claude","useExternalArbiter":true}
```

### `custom`

Use only when the built-in templates are not the right fit.

Example:

```text
/puppenclaw campaign {"projectId":"demo-project","workerId":"local","name":"custom-run","template":"custom","steps":[{"title":"Design","kind":"plan","executor":"acp","instruction":"Design the next phase."},{"title":"Run tests","kind":"eval","executor":"command","command":"npm test"}]}
```

## Raw ACP Session Control

Raw sessions still exist and are useful for admin or debugging work.

Examples:

```text
/puppenclaw start {"agent":"codex","name":"api-refactor","directory":".","task":"Implement the server side."}
/puppenclaw send {"name":"api-refactor","message":"Continue and run tests.","stream":true}
/puppenclaw status {}
/puppenclaw stop {"name":"api-refactor"}
```

Use the orchestration surface first when the work is project-shaped. Use raw sessions when the operator explicitly wants direct ACP control.

Session HTTP/SSE results expose provider failures without forwarding raw credential diagnostics. `PROVIDER_AUTHENTICATION_REQUIRED` is terminal and non-retryable until an operator refreshes the provider login; `PROVIDER_CONNECTION_FAILED` is retryable. `PROVIDER_AUTHENTICATION_BUSY` identifies temporary Claude credential refresh contention and is also retryable; it does not imply that the login is invalid. Definitive token rejection remains terminal. Retryability does not replay a dispatched research turn automatically, because partial work may already exist. A provider-rejected model turn is a terminal session result rather than an HTTP request failure: JSON returns 200 with the failed session, safe message, code, and retryability, while SSE emits the same typed `error` followed by that terminal `result`. Initial keyed execution and every keyed replay preserve this exact shape. The code and `retryable` flag are also retained in session status, active-turn metadata, and durable turn receipts. `/capabilities` advertises this as `providerFailureContracts` version 2.

## ACP Verification

Before blaming Puppenclaw, prove the ACP stack from the same `HOME` and `cwd`
that the gateway will use.

1. Verify `acpx` itself exists:

```bash
/absolute/path/to/acpx --help
```

2. Verify the adapter can create a session from the same environment:

```bash
HOME=/path/to/openclaw-home /absolute/path/to/acpx --format json --json-strict --cwd /absolute/path/to/project codex sessions new --name smoke-test
HOME=/path/to/openclaw-home /absolute/path/to/acpx --format json --json-strict --cwd /absolute/path/to/project claude sessions new --name smoke-test
```

3. Verify the adapter can answer a prompt from the same environment:

```bash
HOME=/path/to/openclaw-home printf '%s' 'Reply with exactly OK and stop.' | /absolute/path/to/acpx --format json --json-strict --cwd /absolute/path/to/project --approve-reads --non-interactive-permissions deny codex prompt --session smoke-test --file -
HOME=/path/to/openclaw-home printf '%s' 'Reply with exactly OK and stop.' | /absolute/path/to/acpx --format json --json-strict --cwd /absolute/path/to/project --approve-reads --non-interactive-permissions deny claude prompt --session smoke-test --file -
```

4. Only after those succeed, run `/puppenclaw start`.

If your OpenClaw gateway uses an isolated `HOME`, run these checks with that
same `HOME`, not your normal shell profile.

## oc2oc Integration

Current state:

- Puppenclaw recognizes `oc2oc` as a remote channel
- mediated remote control is supported
- deterministic pure-pipe control is supported only when explicitly enabled and exposed
- full typed Puppenclaw-over-`oc2oc` orchestration transport is not yet implemented

Remote control safety gates:

- `remoteControl.requireConversationBinding`
- `/puppenclaw bind`
- `/puppenclaw expose {"agents":["codex"],"allowPurePipe":true}`

Example remote setup flow inside an `oc2oc` conversation:

```text
/puppenclaw bind
/puppenclaw expose {"agents":["codex"],"allowPurePipe":true}
/puppenclaw campaign {"projectId":"remote-project","workerId":"local","name":"baseline","template":"baseline_from_scratch","task":"Implement the worker baseline.","evaluationCommand":"npm test"}
```

## Troubleshooting

### `Project root does not exist`

- Check `orchestration.defaultProjectRoot`
- Check whether `rootDir` was meant to be absolute or relative

### `Worker ... is not allowed to operate on ...`

- Expand `worker.projectRoots`
- Register the worker again with the correct allowed roots

### `Worker ... does not support command execution`

- Either enable `orchestration.allowLocalCommandExecution`
- Or register the worker with `executors: ["acp", "command"]`
- Or use a campaign that does not rely on command steps

### `Puppenclaw daemon is unreachable`

- Start the daemon
- Verify `daemonUrl`
- Run `node dist/daemon/cli.js status --host ... --port ...`

### ACP adapter starts fail

- `spawn acpx ENOENT`
  - `acpx` is not installed or `acpxCommand` is wrong
- `Authentication required`
  - the ACP adapter cannot see valid auth from the gateway/plugin `HOME`
  - either seed auth into that `HOME` or wrap `agentCommands` with an explicit `HOME=...`
- `acpx exited with code 4`
  - rerun the same `acpx` command manually with the same `HOME` and `cwd` as the gateway
  - treat it as an adapter/runtime error until the direct `acpx` test succeeds
- `No acpx session found`
  - the ACP session was never created or is not visible from the current `HOME`
- In all cases, verify the configured `agentCommands` work outside Puppenclaw from the same environment the gateway uses

### Missing final answers and interrupted turns

Assistant progress, tool output, and terminal answers are separate. A Codex
one-shot turn uses its final-message file, or an explicitly final JSON message
with confirmed turn completion. Commentary alone produces a failed
`NO_FINAL_MESSAGE` status, never a replay of the previous answer. Native terminal
failures and unexpected process signals also fail; a user stop remains cancelled
in statistics. Inspect both `activeTurn.exitCode` and `activeTurn.signal`.

ACPX reconnect banners do not authorize replay. Persisted replies require a
current-submission identity and observed completion. An automatic retry is limited
to one explicitly rejected, undispatched queue request; missing acknowledgements
and partial work are not automatically resubmitted.

Claude planning turns have one narrow exception to ACPX's nonzero-exit handling:
exit 5 can mean the read-only boundary selected "No, keep planning" when the
agent requested to leave plan mode. A fresh answer, a correlated `end_turn`, and
a final permission exchange holding the plan expose it for user approval.
Earlier tool denials are accounted for and reported separately; when other tools
requested permission, the actual offered plan is required. Every permission must
have a matched decision, and exit 5 requires that none were approved. Missing
evidence, errors, signals, later tool requests, and `deny-all` remain failures.
The actual exit code stays in diagnostics; the exception neither approves the
plan nor retries a denied tool or resubmits the prompt.

On Linux, one-shot diagnostic summaries are stored in the controller's
`<data-dir>/diagnostics/` directory, using hashed session/turn identifiers and
owner-only permissions. They retain event metadata, redacted runtime stderr, real
exit/signal information, and final-file metadata—not credentials, reasoning, or
raw tool/request payloads. Keep this directory outside every agent mount.
Records are periodically flushed and limited to 1 MiB per turn, ten turns per
session, seven days, and 128 MiB globally. Session purge erases its diagnostics.
Diagnostic persistence failure does not interrupt scientific work.

## Development

```bash
npm install
npm run build
npm run verify
```

Useful source files:

- `src/orchestrator/runtime.ts`
- `src/orchestrator/store.ts`
- `src/plugin/service.ts`
- `src/plugin/tools.ts`
- `src/plugin/commands.ts`
- `src/plugin/gateway-methods.ts`

## License

MIT
