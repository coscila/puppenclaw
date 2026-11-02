# puppenclaw

puppenclaw runs coding agents on behalf of other programs. It starts Claude Code and Codex sessions through the Agent
Client Protocol (ACP), supervises their processes, persists every turn and serves all of it over a local HTTP API. A
caller can dispatch a turn under a key, so that it runs at most once, stream its output and read the recorded outcome
again later; a keyed turn that a daemon restart cut off is reported as `TURN_INTERRUPTED_RESTART` and never runs a
second time. The same code also loads as an [OpenClaw](https://github.com/openclaw/openclaw) plugin with project and
campaign orchestration.

For orchestrated research work, puppenclaw adds a model broker. Each orchestrated turn gets a private Unix socket over
which its agent submits worker jobs and, where the deployment routes them there, sends its own model calls and web
requests. The broker calls providers with API keys from the daemon's environment, meters every call it makes and
records a receipt for it, enforces capacity, egress and worker policies, and publishes settled jobs and receipts on an
acknowledged event feed, from which the caller copies them into its own database. Routing an agent's own traffic into
the socket is the job of the deployment's sandbox (see [What a deployment provides](#what-a-deployment-provides)).

puppenclaw is the execution plane of the coscila laboratory record: coscila decides and records, puppenclaw executes and
reports. puppenclaw does not depend on coscila; identifiers with the prefix `ocsl` (for example `ocsl_workflow_v1`)
come from that lab.

What puppenclaw is not:

- **Not a system of record.** It keeps in-flight state and the records a caller has not collected yet. Callers keep
  their own copy of outcomes, usage and receipts. Failed and stopped sessions are purged once they have been idle for
  longer than `sessionTtlMinutes` (by the plugin every minute, by the daemon on `POST /gc`); every other session stays
  until a caller stops or purges it.
- **Not a workflow engine.** It runs what it is asked to run and reports what happened. It never re-sends a dispatched
  turn prompt and never starts a turn on its own. Its one continuation happens inside an orchestrated turn: when the
  agent finishes while its worker jobs still run, the daemon waits for them and continues the same turn with a
  notification that lists the settled jobs, so that the agent integrates their results. Bulk model calls of the broker
  are retried when they fail transiently, and a run principal's unsettled items run again after a restart (see
  [docs/broker.md](docs/broker.md#provider-pauses-and-retries)).
- **Not a login manager.** It does not log in to Claude or Codex. The agents use their own credentials; provider API
  keys for broker-routed calls come from environment variables of the daemon.
- **Not a sandbox.** It sets socket permissions, applies egress rules to the traffic that reaches its broker socket and
  checks the compute launcher, but process isolation, and routing an agent's traffic into the socket, come from the
  sandbox a deployment installs. This repository ships none.
- **Not a multi-tenant server.** One bearer token guards the whole API. Bind it to loopback.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [HTTP API](#http-api)
- [Advanced orchestration and the broker](#advanced-orchestration-and-the-broker)
- [Security model](#security-model)
- [Operations](#operations)
- [Development and tests](#development-and-tests)
- [License](#license)

Reference documents: [configuration](docs/configuration.md), [HTTP API (v1)](docs/http-api.md),
[pcp/2](docs/pcp2.md), [broker](docs/broker.md), [operations](docs/operations.md),
[OpenClaw plugin](docs/openclaw-plugin.md). They are part of the repository; the npm package includes this README but
not `docs/`.

## Requirements

- Node.js 22.13 or later (the daemon stores its state with `node:sqlite`). `.nvmrc` and CI use Node 24.18.0.
- npm.
- Linux. Process supervision, the boot reaper, resource sampling and compute jobs read `/proc`; compute jobs also need
  Bubblewrap (`bwrap`).
- `acpx`, the ACP command-line client (npm package `acpx`), and working ACP adapters for the agents you use, such as
  `@agentclientprotocol/claude-agent-acp` and `@zed-industries/codex-acp`, logged in on the host. Without
  `agentCommands`, acpx starts its own adapter for the `claude` or `codex` alias.
- The `codex` CLI for Codex sessions that run on a configured model provider (one `codex exec` per turn).
- `openssl` on `PATH` for broker-routed Claude Code turns (the OAuth relay issues its own certificate).
- OpenClaw `>=2026.3.0 <2027`, only for the plugin. The daemon never loads OpenClaw.

## Quick start

### Build

```bash
git clone https://github.com/coscila/puppenclaw.git
cd puppenclaw
npm ci
npm run build
```

`npm run build` regenerates `openclaw.plugin.json` from the configuration schema and bundles `dist/` with tsup.

### Run the daemon

Write a configuration file, for example `daemon.json`, and keep it private (`chmod 600`): it holds the bearer token.

```json
{
  "daemonAuthToken": "<long random token>",
  "defaultAgent": "claude",
  "permissionMode": "approve-reads",
  "orchestration": {
    "defaultProjectRoot": "/srv/agent-workspaces",
    "localWorker": { "projectRoots": ["/srv/agent-workspaces"] }
  }
}
```

```bash
node dist/daemon/cli.js start --host 127.0.0.1 --port 18795 \
  --data-dir /var/lib/puppenclaw --config ./daemon.json
```

Without options the daemon listens on `127.0.0.1:18795`, keeps its state in `.puppenclaw-daemon/puppenclaw` under the
working directory and runs with the default configuration, which has no bearer token. The package installs the same
entry point as the `puppenclaw-daemon` binary. The subcommand comes first: the first argument is always read as the
command, and anything but `status` or `stop` in that place, `--help` included, starts the daemon; an option given
before the subcommand is not applied.

```bash
node dist/daemon/cli.js status                       # GET /health, open even with a token
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18795/v2/health
node dist/daemon/cli.js stop --config ./daemon.json  # POST /shutdown with the configured token
```

Here `$TOKEN` holds the configured `daemonAuthToken`. `SIGTERM` or `SIGINT` also stops the daemon cleanly (see
[Operations](#operations)).

### Run a first turn

The session directory must exist before the first turn:

```bash
mkdir -p /srv/agent-workspaces/demo
curl -sS -X POST http://127.0.0.1:18795/session/start \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"agent":"claude","name":"demo","directory":"/srv/agent-workspaces/demo",
       "task":"List the files in this directory.","turnKey":"demo-1"}'
```

The request returns when the turn has ended. Sending it again with the same `turnKey` returns the recorded result
without running the agent a second time. To follow a turn live, use the `/stream` variant, which answers with
server-sent events:

```bash
curl -sS -N -X POST http://127.0.0.1:18795/session/demo/send/stream \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"message":"Now count them.","turnKey":"demo-2","keyedStreaming":true}'
```

### Use it as an OpenClaw plugin

```bash
openclaw plugins install /path/to/puppenclaw
```

Restart the gateway and configure the plugin under `plugins.entries.puppenclaw.config`. With `"backend": "local"` the
plugin runs the agents itself; with `"backend": "daemon"` it talks to the daemon at `daemonUrl`. The plugin adds agent
tools, the `/puppenclaw` command, gateway methods and campaign templates; see
[docs/openclaw-plugin.md](docs/openclaw-plugin.md).

## Configuration

One JSON object configures both the plugin and the daemon (`--config`). Unknown keys are refused.

| Key | Default | Meaning |
| --- | --- | --- |
| `backend` | `local` | Plugin only: `local` runs agents in the plugin process, `daemon` talks to `daemonUrl`. |
| `daemonUrl` | `http://127.0.0.1:18795` | Plugin only: the daemon to use. |
| `daemonAuthToken` | unset | Bearer token. When set, the daemon requires it on every route except `GET /health` and `GET /capabilities`. |
| `defaultAgent` | `claude` | `claude` or `codex`. |
| `permissionMode` | `approve-reads` | `approve-reads`, `approve-all` or `deny-all`. A turn may request another mode unless this is `deny-all`. |
| `maxSessions` | `5` | Persistent agent runtimes admitted at once; idle, unfocused ones may be suspended to admit new work. |
| `sessionTtlMinutes` | `60` | Failed or stopped sessions idle for longer are purged by garbage collection; idle, waiting and suspended sessions are kept. |
| `streamOutput` | `true` | Accepted and reported in `GET /capabilities`; output is captured and streamed whatever its value. |
| `acpxCommand` | `acpx` | The ACP launcher. |
| `agentCommands.claude`, `agentCommands.codex` | unset | Raw ACP adapter commands, passed to acpx as `--agent`. `agentCommands.codex` is also the launcher of the `codex` CLI for provider sessions (default `codex`). |
| `codexCommand` | unset | Optional launcher that wraps provider Codex turns as `<codexCommand> --cwd <dir> -- <codex launcher> exec …`. |
| `skillRoots` | `[]` | Extra directories of Claude Code skills (`<skill>/SKILL.md`). |
| `orchestration.defaultProjectRoot`, `orchestration.localWorker.projectRoots` | unset, `[]` | Workspace roots: campaign projects resolve against them and compute jobs must run inside them. |

The full list, including `resourceSamplingIntervalMs`, `mcpServers`, `remoteControl` and the campaign settings, is in
[docs/configuration.md](docs/configuration.md).

Broker, maintenance and compute settings come from environment variables of the daemon process. The most important
ones:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUPPENCLAW_MODEL_PROVIDERS` | unset | JSON array of model provider configurations that run principals may be granted. |
| `PUPPENCLAW_BULK_PROVIDER_CONCURRENCY` | `60` | Bulk calls in flight per provider; `PUPPENCLAW_BULK_PROVIDER_LIMITS`, `PUPPENCLAW_BULK_PROVIDER_GROUPS` and `PUPPENCLAW_BULK_GROUP_LIMITS` refine it. |
| `PUPPENCLAW_BULK_RESPONSE_TIMEOUT_MS` | `1800000` | Deadline of each bulk call, headers and body. |
| `PUPPENCLAW_EVENT_RETENTION_DAYS` | off | Prune acknowledged feed events older than this (at least 7). |
| `PUPPENCLAW_SHUTDOWN_TIMEOUT_MS` | `20000` | Longest graceful shutdown before the process exits with code 1. |
| `PUPPENCLAW_BOOT_REAPER` | `observe` | What a start does with agent process groups a crashed daemon left behind: `observe`, `on` or `off`. |
| `PUPPENCLAW_COMPUTE_SANDBOX_WRAPPER`, `LAB_SANDBOX_CONFIG` | unset | The trusted launcher and Bubblewrap policy that compute jobs require. |

Invalid broker settings stop the daemon at startup instead of falling back. Every variable is described in
[docs/configuration.md](docs/configuration.md#environment-variables).

## HTTP API

Requests and responses are JSON (turn streams use server-sent events, compute logs plain text). When
`daemonAuthToken` is set, every route except `GET /health` and `GET /capabilities`
requires `Authorization: Bearer <token>` and answers `401 {"ok":false,"error":"unauthorized"}` otherwise. Every
response carries the identity headers `x-puppenclaw-protocol: 2.0`, `x-puppenclaw-boot-id` (new on every start) and
`x-puppenclaw-spool-id` (changes only when the persisted in-flight state is replaced). Most errors answer
`{"ok": false, "code": "...", "error": "...", "details"?: {...}}` with a status set by the code: 400 for invalid input,
404 for an unknown session, 409 for conflicts, 503 when the daemon cannot serve the request now. A code without an
assigned status answers 500, `UNSUPPORTED_REASONING_MODE` and a malformed JSON body among them; the status table and
its exceptions are in [docs/http-api.md](docs/http-api.md#conventions).

### Version 1 routes

Session, campaign and usage routes answer in the tool envelope `{"content": [{"type": "text", "text": "..."}],
"details": {...}}`, which the OpenClaw plugin shares.

| Area | Routes |
| --- | --- |
| Discovery | `GET /health`, `GET /capabilities`, `GET /skills` |
| Turns | `POST /session/start`, `POST /session/:name/send`, and their `/stream` variants (server-sent events) |
| Session state | `GET /sessions`, `GET /session/:name`, `GET /session/:name/output`, `GET /session/:name/transcript`, `GET /session/:name/processes` |
| Session control | `POST /session/:name/{resume,suspend,focus,unfocus,fork,purge,quiesce,quiesce/release}`, `DELETE /session/:name`, `POST /gc` |
| Account cleanup | `POST /sessions/owner/{list,quiesce,purge}` |
| Usage and statistics | `GET /usage`, `GET /session/:name/cost`, `GET /usage/ledger`, `GET /statistics/turns`, `POST /statistics/chats/:chatId/purge` |
| Resources | `GET /resources`, `GET /resources/history` |
| Worker jobs | `GET /orchestration/jobs`, `GET /orchestration/jobs/:jobId/results`, `GET /orchestration/receipts` |
| Compute jobs | `GET /compute/capacity`, `POST /compute/jobs`, `GET /compute/jobs/:id`, `GET /compute/jobs/:id/logs`, `POST /compute/jobs/:id/cancel` |
| Campaigns | `POST /orchestrator/{project,worker,context-sync,campaign,approve,cancel,reassessment}`, `GET /orchestrator/{status,artifacts,events,reassessment/status,reassessment/report}`, `GET /orchestrator/artifacts/:artifactId/content` |
| Site | `GET /site/status`, `GET /site/logs` |
| Operations | `GET /ops/idle`, `POST /recovery/reset`, `POST /shutdown` |

Request bodies, query options, streaming events, lifecycle fencing, account cleanup and the error codes are described in
[docs/http-api.md](docs/http-api.md). `GET /capabilities` lists what this daemon supports, so a client can check a
feature before it sends a field that older daemons would refuse.

### pcp/2

pcp/2 is protocol version 2.0 of the daemon. It keeps the version 1 routes and adds an identity envelope, cheap
authenticated health, keyed turns with compact results, and the broker's feed, instruments and principals. Every v2
response body carries `{protocol, bootId, spoolId}`, except the `401` of the bearer check, and all v2 routes require
the bearer token whenever one is set.

| Feature (`/v2/capabilities`) | What it provides |
| --- | --- |
| `health` | `GET /v2/health`: constant cost and under 1 KB: build, uptime, active turns, stream and write backlog, event-loop lag, memory. |
| `compactStatus`, `keyedStreaming`, `sseGap` | Opt-in compact session views, turn-scoped results, live output for keyed turns, and a `gap` event when a slow stream drops progress events. |
| `usageLedger`, `opsIdle` | `GET /usage/ledger` with a durable cursor; `GET /ops/idle` with counts only. |
| `eventFeed`, `brokerOutbox` (level 2) | `GET /v2/events` and `POST /v2/events/ack`: the broker's job and receipt events in sequence order, served after they are on disk, never pruned before they are acknowledged. |
| `instrumentMode`, `instrumentVerbatim` | `PUT /v2/instruments/{digest}` and `GET /v2/instruments`: allow-listed measurement bundles that fix prompt, schema and sampling; verbatim bundles send the caller's messages byte for byte. |
| `principals` | `PUT`, `GET` and `DELETE /v2/principals/{id}`: bulk authority with grants and budgets, exercised only through the principal's own Unix socket. Needs a bearer token. |
| `bulkCapacity` | The bulk limits per provider and capacity group, the deadline and the retries the broker applies; never an endpoint or a credential variable. |
| `workerPolicy` | Capability profiles, evidence policies and pinned instruments per worker, enforced at admission. |

**Keyed turns.** A `turnKey` (1–128 characters of `A-Za-z0-9._:-`) on `POST /session/start` or
`POST /session/:name/send` makes the turn durable and idempotent within its session. The daemon records the key before
it starts the agent. Repeating the same request under the same key waits for the running turn or replays its recorded
result; the same key with a different request is refused with `409 TURN_KEY_CONFLICT`. A key whose turn was running when
the daemon stopped is never launched again: once the turn's process is proven gone, the key replays the error
`TURN_INTERRUPTED_RESTART`; while it may still run, a repeat answers `409 TURN_REPLAY_UNAVAILABLE`. A session refuses a
new key while a keyed turn is unsettled. Each session keeps the results of its last 64 keyed turns and up to 4,096
keys; beyond that a new key is refused until the session is purged. A keyed turn's result, on the first answer and on
every replay, carries this turn's output and a compact session snapshot, never the transcript; `"resultView": "turn"`
gives unkeyed results the same compact shape and adds `protocol`, `bootId` and `spoolId`. A keyed turn's stream
carries no live output unless the request sets `"keyedStreaming": true`.

Health, capabilities, the event feed, instruments, principals and bulk capacity are specified in
[docs/pcp2.md](docs/pcp2.md).

## Advanced orchestration and the broker

A turn may carry an `orchestration` object (`version: 1`) that lists worker configurations: an id, an assignment, the
agent (`claude` or `codex`) and the model provider it runs on. Such a turn needs a `statisticsContext` and a registered
`modelProvider`. For its duration the daemon opens a private Unix socket and passes its path to the agent as
`PUPPENCLAW_ORCHESTRATION_SOCKET`. Over that socket the agent can:

- list its workers and their capacity (`GET /configs`);
- submit **agent jobs** (`POST /agent/submit`), each a separate agent session that runs a task under the parent turn's
  permissions;
- submit **bulk jobs** (`POST /bulk/submit`): many tool-free model calls against an OpenAI-compatible provider, with an
  optional JSON Schema for the answers or an installed instrument, from an approved execution turn (`execute` mode with
  `approve-all`);
- read, page, cancel and resume its jobs (`GET /jobs`, `GET /jobs/{id}`, `GET /jobs/{id}/results`,
  `POST /jobs/{id}/cancel`, `POST /jobs/{id}/resume`);
- call its own model through the recorded transport (`/native/...`) and reach public web hosts through the socket's
  HTTP proxy and `CONNECT` tunnels.

The broker reads API keys from the daemon's environment (the provider's `authTokenEnv`) and adds them to the upstream
calls it makes. In the environment of an orchestrated turn's agent, and of each agent job, the daemon replaces only that
process's own provider key variable with a placeholder (not for `claude-code` providers, which use Claude Code's own
login). Every other variable of the daemon's environment, the keys of worker and run principal providers included,
reaches the agent unchanged unless the deployment removes it (see [Security model](#security-model)).

Every model call that passes through the broker gets a receipt with token usage, the model the upstream named, its
fingerprint and digests of the request settings, which reaches the session's statistics and usage ledger. Each settled
bulk item and each job state change is written, in the same transaction, to an outbox that callers read as the pcp/2
event feed. Rate limits and authentication failures pause the provider for the turn; bulk calls that fail transiently
(502, 503, 504, timeouts, connection resets) are retried with backoff, each attempt a new provider request. A
provider-wide limiter shares bulk capacity across jobs and sessions, and providers that address the same backend can
share one capacity group.

**Run principals** carry bulk authority independent of a chat turn, for example for a study run: the caller grants
providers, instruments, concurrency, an item cap, a token budget and an expiry, and the daemon opens a socket that only
that principal can use. **Worker policies** restrict individual workers to evidence-only bulk calls, fixed programs,
pinned instruments or on-premises providers.

Socket routes, job states, receipts and their provenance fields, paging, retries, capacity groups, worker policies and
the broker store are described in [docs/broker.md](docs/broker.md).

### What a deployment provides

The daemon opens the socket and sets the variables listed in
[docs/configuration.md](docs/configuration.md#variables-the-daemon-sets-for-child-processes); it does not change how
an agent reaches the network. Jobs submitted over the socket always run through the broker. An agent's own model calls
and web requests reach the broker only where the deployment sends them there, typically from a sandbox whose only way
out is the socket:

- the agent's model base URL points at the socket's `/native` path, through a bridge from TCP to the Unix socket for
  agents that cannot use a socket directly;
- its HTTP and HTTPS proxy is the socket (absolute `http://` requests and `CONNECT` tunnels);
- Claude Code trusts the certificate in `PUPPENCLAW_ORCHESTRATION_CLAUDE_OAUTH_CERT`, so that its token refresh passes
  through the relay;
- the provider key variables that the agent must not hold are removed from its environment;
- the agent can neither read the daemon's configuration file, which holds the bearer token, or its data directory, nor
  reach the daemon's HTTP port.

Without this wiring an agent calls its provider and the web directly, as the daemon's user, and those calls get no
receipt, metering, egress check or relay. This repository ships no bridge and no sandbox.

## Security model

**Authentication.** Set `daemonAuthToken` for every deployment. The token is compared in constant time; only
`GET /health` and `GET /capabilities` stay open. Without a token the daemon accepts every request from anyone who can
reach the port, session purge, garbage collection and recovery reset included, and `POST /orchestrator/campaign` can
run shell commands, so an unauthenticated daemon is only safe on a loopback address, where every local process can
still call it. Three groups of routes refuse to work without a token at all: run principals, account cleanup (and
`ownerKey` on a turn) and statistics erasure answer `DAEMON_AUTH_REQUIRED`.

**Sandbox boundary.** puppenclaw does not isolate processes itself; a deployment runs the agents in its own sandbox.
Agents, codex launchers and compute launchers run as the daemon's user, so without a sandbox an agent can read the
configuration file with the bearer token and the data directory, and call the daemon's API. The daemon keeps what a
sandbox must not reach outside it:

- Broker sockets: one per turn in a `0700` directory under `/tmp` (`ocsl-model-broker-<uid>-<hash>`), principal sockets
  in `0700` directories under `<data-dir>/principals/`, each socket `0600`. All processes of one user can open them, so
  they separate sandboxes, which must not mount these paths, not unsandboxed processes of the same user.
- Credentials: agent processes inherit the daemon's environment, from which the broker reads provider keys. The daemon
  replaces only an orchestrated process's own provider key variable with a placeholder, and a turn without
  orchestration gets the environment unchanged; every other key reaches the agents unless the deployment's launcher (an
  `acpxCommand` or `codexCommand` wrapper, or its sandbox) removes it. The Claude OAuth relay forwards only Claude
  Code's own token refresh to `platform.claude.com` and keeps no credential, and native Claude calls with an API key are
  refused.
- Egress, for traffic sent to the socket: the proxy allows public web hosts on ports 80 and 443 only. It refuses
  (`EGRESS_DENIED`) IP literals, `localhost`, `.local` and `.internal` names, private, loopback and link-local
  addresses, the known model API hosts, the endpoints of the providers that orchestrated turns and their workers name
  (from the first such turn until the daemon stops), daemon environment variables named like model endpoints and the
  direct upstreams ([docs/broker.md](docs/broker.md#egress)). A provider configured only for run principals is not on
  that list. The broker resolves DNS itself and pins the address, and a TLS server name must match the tunnel's
  authority.
- Compute jobs run only through a launcher and Bubblewrap policy named by `PUPPENCLAW_COMPUTE_SANDBOX_WRAPPER` and
  `LAB_SANDBOX_CONFIG`. Both are absolute paths of regular files, not symlinks, outside every workspace root; the files
  and their parent directories must be owned by the daemon user and not writable by group or others. The launcher must
  answer the `ocsl-compute-sandbox-v1` handshake. A job's environment travels on a separate file descriptor and can
  never select the launcher, its policy or host mounts. A lab installs its own launcher; this repository ships none.
  The interface a launcher implements is described in [docs/operations.md](docs/operations.md#compute-launcher).

**What the daemon never does:**

- store or inject Claude subscription tokens: the Claude Code binary owns its login, and the broker forwards its
  requests and keeps only an in-memory digest to recognise a renewed token;
- put a provider credential into a receipt, feed event or turn diagnostic; error texts are redacted before they leave
  the daemon;
- re-send a dispatched turn prompt by itself, or relaunch a keyed turn that was running when it stopped (bulk model
  calls are retried and resumed as [docs/broker.md](docs/broker.md#provider-pauses-and-retries) describes);
- prune a feed event before it is acknowledged, or erase a broker job's records ahead of the feed;
- signal a leftover process group it cannot prove it started (pid and start time must match, and the kernel boot id
  too when the record carries one);
- accept a principal identity from a header, body field or environment variable: the principal's socket is its
  identity;
- run a verbatim instrument for anything but a run principal granted that instrument.

## Operations

**State.** One daemon owns a data directory at a time (`.state-owner.json` is its lease; a second daemon refuses to
start with `STATE_ROOT_IN_USE`). Sessions, turn receipts and fences live in `state.json`; usage, statistics,
campaigns, broker jobs, principals, compute jobs and resource samples live in SQLite files in subdirectories. The layout
is listed in [docs/operations.md](docs/operations.md#data-directory). If `state.json` cannot be loaded, the daemon
keeps the previous file, starts read-only and refuses every mutating request with `STATE_RECOVERY_REQUIRED` until an
operator calls `POST /recovery/reset` with `{"confirm": "reset-session-state"}`; the reset starts a new spool.

**Backups.** Stop the daemon and copy the whole data directory; the stores are written continuously, several in WAL
mode, so a copy of a running daemon's files is not consistent. Back it up before every upgrade: stores migrate in place
when a newer version opens them.

**Shutdown.** The first `SIGTERM` or `SIGINT` stops accepting requests, ends connections still open after 2 s, wakes
long polls, stops principal jobs so that the next start resumes them, closes the stores and releases the lease, then
exits with code 0. A second signal, a failing close or a close that outlasts `PUPPENCLAW_SHUTDOWN_TIMEOUT_MS` exits with
code 1. Agent process groups are detached and keep running; at the next start `PUPPENCLAW_BOOT_REAPER` decides whether
leftover groups are only counted (`observe`, the default) or terminated (`on`).

**Upgrade.** Wait until `GET /ops/idle` reports no active turns, jobs or streams, stop the daemon, back up the data
directory, build the new version and start it. Turns that were running are reconciled at start: a turn whose process is
gone is marked failed, a session whose process may still run stays fenced until it is gone, and keyed turns are never
launched again. Bulk jobs of run principals resume under the same job id; other interrupted jobs wait for an explicit
resume. Store changes are additive and covered by
rollback tests in which earlier daemons open a store this version wrote; see
[docs/operations.md](docs/operations.md#upgrade-and-rollback).

**Maintenance.** Archiving of old broker jobs (`PUPPENCLAW_ADVANCED_ARCHIVE_DAYS`) and event retention
(`PUPPENCLAW_EVENT_RETENTION_DAYS`) are off unless configured. Turn diagnostics, resource history and campaign
artifacts have their own retention limits; see [docs/operations.md](docs/operations.md#retention).

## Development and tests

```bash
npm ci
npm run verify     # manifest sync and build, tsc --noEmit, vitest run
npm run typecheck
```

The tests run the real daemon, stores and broker against fake agents (`test/fixtures/fake-acpx*`), mock upstreams and
temporary data directories; they need no provider account and no OpenClaw gateway. A few opt-in tests are skipped
unless their environment is present. `test/fixtures/contract/` holds the daemon's session status and output envelopes
as committed fixtures; `scripts/emit-contract-fixtures.ts` regenerates them and a unit test fails when the emitted shape
drifts. The scripts in `scripts/measure-*.mts` measure health cost, event-loop lag and bulk throughput against a daemon
or runtime they start themselves.

GitHub Actions runs the commit guard and `npm ci`, build, lint, typecheck and tests on pushes to `main` and `dev` and
on pull requests. Source layout: `src/daemon` (HTTP server and pcp/2), `src/manager` (agent sessions through acpx and
Codex), `src/advanced` (broker, principals, worker policy), `src/compute`, `src/statistics`, `src/resources`,
`src/orchestrator` (campaigns), `src/plugin` (OpenClaw plugin) and `skills/` (agent skills shipped with the plugin).

## License

MIT; see [LICENSE](LICENSE).
