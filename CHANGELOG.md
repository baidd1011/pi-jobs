# Changelog

All notable changes to this project are documented in this file. The project follows Semantic Versioning.

## [Unreleased]

## [1.2.0] - 2026-07-29

### Added

- `/job digest [--hours N] [--markdown] [--notify]` to summarise the last 24 hours (or any positive hour window) with grouped done / failed-overbudget-timeout / canceled jobs, total cost and duration, per-job review command, and an extra list of all open `cleanup-needed` jobs that ignores the time window.
- `--markdown` writes the digest atomically to `~/.pi/jobs/reports/digests/<timestamp>.md`; repeated runs produce independent files.
- `--notify` sends a native Windows toast with counts, cost, and pending cleanup count; non-Windows runs or toast failures downgrade to a Pi warning, never an error.
- `/job audit <id>` to render and write a full Markdown audit report (prompt, times, repo, base, dirty warning, runtime, status timeline, tokens, cost, duration, budget, stop, error, result branch and commit, `git diff --stat`, file status, review command, log and session paths) atomically to `~/.pi/jobs/reports/audits/<id>-r<revision>.md`.
- `/job cleanup [--dry-run]` for conservative housekeeping: dry-run is byte-identical to the input; a real run only removes heartbeat, marker, qualifying temp files, and clean, commit-matching terminal worktrees, and reports `removed / skipped / manual-action` for every other case.
- Read-only `lib/report.mjs` and `lib/cleanup.mjs` shared by digest and audit.
- `lib/notify.mjs` with the Windows Toast wrapper.
- Schema v3 jobs that record the actual `runtime` (`provider`, `model`, `piVersion`, `piPath`, `capturedAt`) once on entering the agent phase; old v1/v2 jobs remain read-only and render missing fields as `unknown / not recorded`.
- Tests covering the 24-hour boundary, all terminal groups, max-turns detail, totals, review commands, out-of-window cleanup-needed, Markdown atomic output, event dedup and reconcile, runtime capture, stop timeline, git summary, snapshot of running jobs, and the full cleanup matrix.

### Changed

- `doctor` is now a pure check: it no longer removes terminal heartbeats, instead reporting how many are present and pointing the user at `/job cleanup`.
- `/ns digest` is now an alias for the new digest command (it still shows the deprecation warning).
- Help text, Chinese and English READMEs, and the version metadata all describe the new commands and the new `reports` directory.

### Fixed

- Normalize Git worktree paths on Windows and revalidate every cleanup target immediately before deletion.
- Restrict atomic-temp cleanup to managed state directories, excluding worktrees, logs, reports, reparse points, and legacy data.
- Show `would-remove` entries during dry-run and reject unknown digest/cleanup arguments.
- Preserve wall-clock timeout details, relative session paths, and collision-free digest report names without inventing audit data.
- Pass Windows Toast arguments out-of-band and always remove the temporary PowerShell script.

## [1.1.0] - 2026-07-28

### Added

- `/job version` with the running package version and scheduled runner status.
- An actionable doctor check for stale scheduled-task runner paths.
- A clean-machine acceptance test covering Git package loading, command registration, fake-RPC branch delivery, scheduler setup, doctor, and uninstall.
- Windows CI for supported Node.js versions and distribution smoke tests.
- Automatic GitHub Release creation after tag CI and distribution acceptance pass.
- Chinese-default and English README variants.

### Changed

- Mark the Pi host package as an optional peer dependency so Git installs do not duplicate Pi's dependency tree.
- Add Windows, Node.js, repository, license, and package-content metadata.

## [1.0.0] - 2026-07-27

### Added

- Auditable, sequential background job queue for Pi on Windows.
- Isolated Git worktree execution with local result-branch delivery.
- Budget, timeout, cancellation, crash recovery, heartbeat, migration, and doctor support.
- Initial 34-test fake-RPC and Git integration suite.

[Unreleased]: https://github.com/baidd1011/pi-jobs/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/baidd1011/pi-jobs/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/baidd1011/pi-jobs/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/baidd1011/pi-jobs/releases/tag/v1.0.0
