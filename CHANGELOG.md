# Changelog

All notable changes to this project are documented in this file. The project follows Semantic Versioning.

## [Unreleased]

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

[Unreleased]: https://github.com/baidd1011/pi-jobs/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/baidd1011/pi-jobs/releases/tag/v1.0.0
