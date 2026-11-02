# Operations

## Data directory

One daemon owns a data directory (`--data-dir`, default `.puppenclaw-daemon/puppenclaw` under the working directory).
Files hold session state, receipts and broker inputs, so keep the directory private to the daemon user and out of every
sandbox mount.

| Path | Contents |
| --- | --- |
| `.state-owner.json` | The owner lease: process id and start identity of the daemon that owns the directory. |
| `state.json` | Sessions, transcripts, keyed-turn receipts, lifecycle fences and owner claims (mode `0600`). |
| `spool.json` | The spool identity reported as `spoolId`. |
| `runners/` | One record per detached agent process group, for the boot reaper. |
| `diagnostics/` | Redacted turn diagnostics (see [below](#turn-diagnostics)). |
| `usage/usage.sqlite` | The usage ledger. Rows are never deleted. |
| `statistics/statistics.sqlite` | Conversation turn statistics. |
| `orchestrator/orchestrator.sqlite`, `orchestrator/artifacts/` | Projects, workers, campaigns, runs and their artifacts. |
| `advanced/advanced.sqlite`, `advanced/archive/` | Broker jobs, items, inputs, receipts, the feed outbox and the instrument allow-list; verified archives. |
| `principals/principals.sqlite`, `principals/<random>/broker.sock` | Run principals and their sockets. |
| `compute/compute.sqlite`, `compute/jobs/` | Compute job records, specs, state files and logs. |
| `resources/resources.sqlite` | Resource samples. |

The broker's per-turn sockets live outside the data directory, under `/tmp/ocsl-model-broker-<uid>-<hash>/`.

A second daemon on the same directory refuses to start with `STATE_ROOT_IN_USE` while the lease's process may still be
alive; a stale lease of a dead process is set aside and replaced.

## State recovery

If `state.json` cannot be loaded, the daemon preserves the file under a quarantine name, starts with empty state in
read-only mode and logs why. `GET /health` reports `ok: false` and `stateRecovery`, and every mutating request answers
503 `STATE_RECOVERY_REQUIRED`, except `POST /recovery/reset`, `POST /shutdown` and principal revocation. After
inspecting the preserved file, an operator resets:

```bash
curl -X POST http://127.0.0.1:18795/recovery/reset -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"confirm":"reset-session-state"}'
```

The reset writes fresh session state and a new spool id, which tells callers that every turn of the previous spool is
gone.

## Backups

Stop the daemon and copy the whole data directory. The stores are written continuously, several in WAL mode, so a copy
of a running daemon's files is not consistent. Back up before every upgrade, because a newer version migrates its stores
in place when it opens them.

## Shutdown and restart

The first `SIGTERM` or `SIGINT` closes the daemon: it stops accepting requests, destroys connections still open after
2 s (long SSE turns would otherwise hold the store), wakes event-feed long polls, stops principal jobs (in-flight calls
are aborted and their items return to the queue), closes the stores and releases the owner lease, then exits with code
0. A second signal, a failing close, or a close that outlasts `PUPPENCLAW_SHUTDOWN_TIMEOUT_MS` (default 20000, at least
1000) exits with code 1, so a service manager's stop request never hangs. `POST /shutdown`, which
`puppenclaw-daemon stop` sends, closes the server, its stores and the lease in the same order, without the signal
handler's connection grace and timeout.

Agent process groups are detached and survive the daemon. At the next start:

- `PUPPENCLAW_BOOT_REAPER` handles groups recorded under `runners/`: `observe` (default) logs and counts them
  (`leftoverRunnerGroups` in `GET /ops/idle`); `on` terminates groups whose leader is provably the recorded process
  (pid and `/proc` start time), with `SIGTERM` and then `SIGKILL`, and asks their acpx runtimes to cancel the
  interrupted prompt; `off` keeps no records. A group whose leader is gone is never signalled, and neither is one
  recorded during an earlier host boot (each record carries the kernel boot id, and pids restart at boot): its record is
  removed.
- Sessions whose turn was running are reconciled before any new work is accepted. A turn whose process is proven gone,
  or which was never dispatched, is marked failed, and its key is settled with the replayable error
  `TURN_INTERRUPTED_RESTART`. A session whose recorded process is not proven gone is fenced, and its key answers
  `TURN_REPLAY_UNAVAILABLE`; the next dispatch clears the fence once the process is gone. A fence that records no process
  makes the session refuse new turns (`RECOVERY_FENCE_ACTIVE`) until it is stopped.
- Broker recovery requeues the unsettled items of bulk jobs; jobs of a run principal that still admits them relaunch
  under their own id, other jobs wait as `interrupted` for an explicit resume. Principal sockets reopen at their old
  paths only after that.
- Compute jobs keep running under their detached supervisors and are reconciled from their state files.

## Upgrade and rollback

1. Wait until `GET /ops/idle` reports no active turns, turn processes, running turn keys, active broker or compute jobs
   and no open streams.
2. Stop the daemon and back up the data directory.
3. Build the new version (`npm ci && npm run build`) and start it.

Store changes are additive. The test suite checks rollback by opening stores written by this version with the store code
of earlier daemons (`test/fixtures/legacy/`):

- Commit `c36cfa2` and earlier (store code of `cea4c29`, whose schema code `c36cfa2` shares) open, read and write an
  `advanced.sqlite` written by this version and ignore the new tables. They write no outbox rows and cannot resume jobs
  whose inputs live only in blobs. When this version reopens the store, it emits the current state of every job, and
  the receipt of every item, that the older daemon changed; a job header the older daemon rewrote is treated as stored
  in an earlier layout from then on, which only makes recovery more conservative. A pending erasure survives the older
  daemon and completes afterwards.
- Daemons without verbatim instruments refuse a verbatim bundle, at the PUT and for jobs that name one, instead of
  running it policy-wrapped; bundles they installed stay valid and idempotent here.
- Daemons without worker policies load the `state.json` this version writes, because worker policy fields are never
  persisted there, and open `advanced.sqlite`, where a job's stored worker configuration keeps its policy fields. They do
  not enforce them, and resuming such a job under their own configuration is refused with `WORKER_CONFIG_CHANGED`.
- Daemons without principals never open `principals.sqlite` and read the added job fields unchanged.

## Archiving broker jobs

`PUPPENCLAW_ADVANCED_ARCHIVE_DAYS` (30–36500; off by default) archives, once a day and at most 50 jobs at a time,
terminal jobs last updated earlier than that into `advanced/archive/advanced-archive-<time>-<id>.sqlite` (mode `0600`)
with their items (inputs materialized), receipts and a manifest of counts and sha256 per job. Each job is copied, counted and digested in both
files, and the live rows go only when both agree. Only jobs whose records provably reached the caller qualify: stored in
the current layout, with every feed event acknowledged. Jobs of a run principal (a study run refers to them), jobs
marked with a study reference, jobs from an earlier layout and jobs with unacknowledged events stay; the log line
`ADVANCED_ARCHIVED` reports what was archived and how many jobs of each kind were kept.

## Retention

| Data | Retention |
| --- | --- |
| Feed events | Kept; `PUPPENCLAW_EVENT_RETENTION_DAYS` (7–36500) deletes acknowledged events older than that, hourly. Unacknowledged events are never deleted. |
| Broker jobs | Kept until the session or owner is purged, or archived (see above). |
| Sessions | Failed and stopped sessions are purged by garbage collection once idle for longer than `sessionTtlMinutes`; idle, waiting and suspended sessions stay until they are stopped or purged. A purge removes transcript, diagnostics and broker jobs. |
| Keyed-turn receipts | 64 outcomes and 4,096 keys per session, until the session is purged. |
| Usage ledger | Never deleted. |
| Statistics | Kept through session purge and garbage collection; removed by `POST /statistics/chats/:chatId/purge`. |
| Campaign artifacts | `orchestration.artifactRetentionHours` (default 336) for campaigns that are not running or waiting for approval. |
| Resource samples | `resourceRetentionDays` (default 7). |
| Turn diagnostics | 1 MiB per turn, 10 turns per session, 7 days, 128 MiB in total; removed with the session. |

## Turn diagnostics

On Linux, provider Codex turns write diagnostic summaries to `diagnostics/` with hashed session and turn identifiers and
owner-only permissions. They keep event metadata, redacted runtime stderr, the real exit code and signal, and metadata of
the final-message file, but no credentials, reasoning, or raw tool and request payloads. Records are flushed
periodically and bounded as listed above. A failure to write diagnostics never interrupts a turn.

## Idle check and monitoring

`GET /ops/idle` reports counts only and measures each at request time; it is the check for a safe restart.
`GET /v2/health` is the cheap liveness probe (event-loop lag, backlog, memory); `GET /health` is the open probe used by
`puppenclaw-daemon status`. `GET /resources` and `GET /resources/history` show host and per-session resource use.

## Compute launcher

Compute jobs (`POST /compute/jobs`, executor `bubblewrap-local`) run only through a launcher that the deployment
provides; this repository ships none. `PUPPENCLAW_COMPUTE_SANDBOX_WRAPPER` names the launcher, a Node script that the
daemon runs with its own Node, and `LAB_SANDBOX_CONFIG` names its policy.

- **Files.** Both are absolute paths of regular files that are their own real paths (no symlinks), owned by the daemon
  user and not writable by group or others. Their parent directories must be owned by the daemon user and not writable
  by group or others either, and neither file may lie inside a workspace root of the policy.
- **Policy.** A JSON object, optionally under a `sandbox` key, with `mode: "bubblewrap"`, an absolute `workspaceRoot` and
  optionally `legacyWorkspaceRoots`, a list of further absolute workspace roots.
- **Handshake.** When the daemon reports capacity and before it accepts a job, it runs
  `node <launcher> --compute-protocol` with a 3 s timeout; the launcher must exit with 0 and print
  `ocsl-compute-sandbox-v1`. `bubblewrap-local` is also available only when `bwrap` runs on the host and the daemon has
  workspace roots.
- **Invocation.** A detached supervisor runs `node <launcher> --compute-env-fd 3 --cwd <cwd> -- <command...>` in the
  job's working directory. The launcher's standard output and error go to the job's log files, and its exit code
  decides the job's state: 0 is `succeeded`, anything else `failed`.
- **Job environment.** File descriptor 3 carries the job's environment as one JSON object of strings: at most 256
  names matching `[A-Za-z_][A-Za-z0-9_]*` (up to 128 characters), values up to 16 KiB, 64 KiB in all, with
  `OMP_NUM_THREADS`, `OPENBLAS_NUM_THREADS` and `MKL_NUM_THREADS` set to the job's `cpuCores` unless the job sets them.
  The launcher gives the sandboxed command this environment instead of its own.
- **Launcher environment.** The launcher itself inherits the daemon's environment, with `LAB_SANDBOX_CONFIG` set to the
  checked policy path and, for a job that names a principal, `PUPPENCLAW_PRINCIPAL_ID`,
  `PUPPENCLAW_PRINCIPAL_SOCKET_DIR` and `PUPPENCLAW_PRINCIPAL_SOCKET`
  ([pcp2.md](pcp2.md#binding-a-principal-socket-into-a-sandbox)). It applies the policy before it starts the command.
- **Stopping.** Cancellation and the wall-time limit send `SIGTERM` to the launcher and `SIGKILL` 5 s later, so the
  launcher must take the sandboxed process down with it.

## Measurements

Three scripts measure the daemon against processes they start themselves; none of them talks to an existing deployment.

- `npm run build && node --experimental-strip-types scripts/measure-h4.mts [--window-ms N] [--stall-ms N]
  [--stall-rate BYTES_PER_S] [--only load|stall]`: starts the built daemon on a free loopback port with a throwaway
  data directory, a large session store and a streaming fake runner, and reports the size and latency of
  `/v2/health`, state writes per minute and event-loop p99 with five live turns, and memory growth while an SSE client
  stalls.
- `node --experimental-strip-types scripts/measure-p1.mts [--items N] [--jobs N] [--streams N] [--latency-ms N]
  [--output-bytes N] [--only paced|max|hooks-off|no-group-commit]`: bulk completions per second and event-loop lag of
  the broker with its real statistics and usage-ledger hooks, against a mock upstream in its own process.
- `node --experimental-strip-types scripts/measure-verbatim.mts [--calls N] [--jobs N] [--submitters N] ...`: the same
  for verbatim instrument calls through a run principal socket (40 entries of about 3 KB per call by default); it checks
  that every call's bytes, as the mock upstream hashed them, equal the receipt's `requestSha256`.
