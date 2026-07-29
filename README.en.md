# pi-jobs

[简体中文](./README.md) | English

[![CI](https://github.com/baidd1011/pi-jobs/actions/workflows/ci.yml/badge.svg)](https://github.com/baidd1011/pi-jobs/actions/workflows/ci.yml)

`pi-jobs` is a Windows-first, auditable background job queue for the Pi coding agent. Submit work from a Pi session, leave the terminal, and receive the result as an isolated local Git branch with durable status, cost, logs, and an append-only derived audit trail.

The first release is deliberately sequential and local: it does not create or push PRs, run jobs in parallel, wake a sleeping computer, retry model calls automatically, or support non-Windows schedulers.

## Installation

Install a pinned release tag:

```powershell
pi install git:github.com/baidd1011/pi-jobs@v1.2.0
```

If `extension/nightshift.ts` or `extension/jobs.ts` was previously registered manually, disable that old entry in `pi config` first to avoid duplicate command registration.

After installation, run inside Pi:

```text
/reload
/job setup
/job doctor
```

Use `pi list` to see the Git package's actual installation path.

Check the running version and whether the scheduled task still points to the current package:

```text
/job version
```

### Upgrade

A Git tag is pinned and is not moved by a normal `pi update`. Install the new tag, then refresh the runner path stored in Task Scheduler:

```powershell
pi install git:github.com/baidd1011/pi-jobs@vX.Y.Z
```

```text
/reload
/job version
/job setup
/job doctor
```

### Uninstall

Remove the scheduled task before removing the Git package. Data, logs, result branches, and retained worktrees are preserved:

```text
/job uninstall
```

```powershell
pi remove git:github.com/baidd1011/pi-jobs
```

## Execution model

1. `/job add` freezes the current repository's committed `HEAD` and atomically writes a queued job. A dirty main worktree is allowed, but its uncommitted changes are never copied into the job.
2. The command writes a wake request and calls `Start-ScheduledTask pi-jobs-worker`.
3. A single worker claims jobs in creation order. Each job runs under `~/.pi/jobs/worktrees/<id>` on a `pi-jobs-<id>` branch; the user's main worktree is never checked out or reset.
4. The worker records cost, tokens, logs, state transitions, and a separate 30-second heartbeat. It commits partial work on success, failure, cancellation, budget stop, or timeout.
5. A changed branch is retained as `branch-ready`. An unchanged branch is removed and reported as `no-changes`. A worktree that Windows will not release is preserved and reported as `failed / cleanup-needed`.

The worker rescans an empty queue once per second and exits only after five consecutive empty scans. The scheduled task uses `MultipleInstancesPolicy=Queue`, closing the add-versus-exit race. The same task has a 15-minute periodic trigger that acts as the watchdog.

## Commands

| Command | Effect |
|---|---|
| `/job add <prompt> [--budget N] [--timeout MIN]` | Freeze committed HEAD, enqueue, and request the worker |
| `/job list [--all]` | Show active jobs or all history |
| `/job status <id>` | Show state, phase, cost, stop detail, base, and delivery |
| `/job log <id>` | Show the job log |
| `/job result <id>` | Show the result branch, summary, and review command |
| `/job cancel <id>` | Cancel immediately if queued or signal the running RPC process |
| `/job retry <id>` | Create a new job and freeze the repository's current committed HEAD |
| `/job digest [--hours N] [--markdown] [--notify]` | Summarise the last N hours (default 24h) with a per-job review command, an extra list of all open `cleanup-needed` jobs, optional Markdown output, and optional Windows toast |
| `/job audit <id>` | Render a full audit in Pi and atomically write `~/.pi/jobs/reports/audits/<id>-r<revision>.md` |
| `/job cleanup [--dry-run]` | Safely remove terminal heartbeats, cancel markers, qualified temp files, and clean, commit-matching worktrees; everything else is reported with a reason and a suggested command |
| `/job setup` | Idempotently register/update `pi-jobs-worker` |
| `/job doctor` | Inspect runtime, provider key presence, scheduler, locks, stale jobs, and worktrees; no longer auto-deletes terminal heartbeats |
| `/job version` | Show the package version and detect a stale scheduled runner path |
| `/job uninstall` | Remove only the scheduled task; preserve all data and Git artifacts |

`/ns` remains as a deprecated compatibility alias for one major version. `/ns rm` maps to cancel and `/ns digest` maps to the new digest command; every use displays a deprecation warning.

Cleanup scans atomic temporary files only in the data root and `jobs/control/heartbeats/locks`; it never descends into `worktrees/logs/reports`. Before deletion it revalidates job state, file identity, worktree cleanliness, and the recorded result commit. `--dry-run` lists every `would-remove` target, and unknown arguments are rejected.

## Setup

Requirements:

- Windows with Node.js 22.19.0 or newer, Git worktree support, and Pi installed.
- The provider API key stored as a **User-level Windows environment variable**. A scheduled task does not inherit keys exported only by `.bashrc`.
- The machine must be awake and the user session must remain logged in; a locked screen is fine.

From Pi, run:

```text
/job setup
/job doctor
```

Setup uses the Windows ScheduledTasks PowerShell module—not `schtasks /Create`—and registers:

- action executable: the current `process.execPath`;
- action argument: this package's `runner/run.mjs`;
- settings: `MultipleInstances Queue` and `StartWhenAvailable`;
- one 15-minute repeating trigger on `pi-jobs-worker`;
- current-user interactive principal, so no password is stored.

If the old `pi-nightshift` scheduled task exists, setup disables it. A missing old task is not an error.

For a manual diagnostic run, find the package directory with `pi list`, then execute:

```powershell
node "<pi-jobs-package-dir>\runner\run.mjs"
```

## Data and authority

New state lives under `~/.pi/jobs/`:

```text
config.json              runtime defaults and the independent piPath
jobs/<id>.json           sole authoritative job record
events.jsonl             derived audit events, keyed by jobId + revision
control/<id>.cancel.json cancellation signals
heartbeats/<id>.json     lightweight worker liveness (no revision/event)
logs/<id>.log            per-job logs
worktrees/<id>/          isolated temporary Git worktrees
reports/digests/         Markdown reports written by /job digest
reports/audits/          Markdown reports written by /job audit
runner.lock              PID + process-start-time + token ownership lock
```

Job states are `queued`, `running`, `done`, `failed`, `overbudget`, `timeout`, and `canceled`. Running phases are `preparing`, `agent`, and `finalizing`. Delivery is always local branch delivery with status `not-started`, `pending`, `branch-ready`, `no-changes`, or `failed`.

New jobs use schema v3: the worker persists `runtime: { provider, model, piVersion, piPath, capturedAt }` once when entering the agent phase and never rewrites it. Older v1/v2 jobs stay read-only; missing fields render as `unknown / not recorded` in audit output and are never faked from the current environment.

`events.jsonl` is never consulted to make runtime decisions. Job writes happen first and event appends second; startup derives any missing revision events. Heartbeats are written separately every 30 seconds and are stale after five minutes. `/job doctor` only reports the count of terminal heartbeats and points the user at `/job cleanup`; it no longer removes them on the fly.

## Stops and recovery

Cancellation is checked every second. Cost is checked from `get_session_stats` every 15 seconds and at turn boundaries, so a budget is a soft cap and can overshoot by an already-billed call. Stop reasons are persisted before `abort`, followed by a forced process-tree kill after the grace period.

Earlier stop timestamps win. Equal timestamps use:

```text
canceled > overbudget > timeout > max-turns
```

`max-turns` is stored as `state=timeout` plus `statusDetail=max-turns` so it is not confused with a wall-clock timeout.

A stale running job is never sent to the model again. Recovery commits whatever is already in its worktree, keeps a persisted cancellation/budget/timeout cause, or reports `failed / worker-crashed` when no stop cause exists. Only `/job retry` creates a new model invocation and possible new cost.

## Legacy migration

`~/.pi/nightshift` is treated as read-only. Migration is idempotent and records imported IDs in the new data directory. Completed results become immutable `legacy-nightshift` records. Old pending tasks without a stored base use the committed HEAD observed during migration and display `migrationBaseApproximate=true`. Old running tasks are imported as failed and are never resumed automatically.

## Tests

```powershell
npm test
```

The suite uses temporary repositories, isolated data roots, and a fake Pi JSONL RPC process. It does not call a real provider or alter `~/.pi/nightshift`.

The clean-machine acceptance test also checks Pi package loading, command registration, fake-RPC branch delivery, and scheduler setup/doctor/uninstall under a unique temporary task name:

```powershell
npm run test:acceptance
```

GitHub Actions runs unit tests on Node.js 22.19.0 and 24.x, plus a separate distribution acceptance job. See [CHANGELOG.md](./CHANGELOG.md) for release history.
