# Changelog

## 0.10.2

### Patch Changes

- 5886f76: `wt update` now shows a `Classifying gone branches (X of N)…` spinner while it classifies stale branches with gone remotes. Previously, after the per-worktree rebase list finished and the root-sync summary printed, the command went silent again for several seconds while it ran `isDirty`, `getCommitCount`, and `isFullyMerged`'s patch-id / cherry-pick detection for each stale branch — with the terminal already looking finished, giving no sign real work was still happening. The spinner covers that window with a running count and stops before the gone-branch list, cleanup confirm prompt, or outro. It only appears when there is at least one stale branch to classify. CLI-layer only, mirroring the existing WTK-67 fetch/analysis phase spinner.

## 0.10.1

### Patch Changes

- 4410021: `wt update` now shows a `Fetching and analyzing worktrees...` spinner during its startup phase instead of leaving the terminal silent for several seconds. Previously the command printed its intro banner and then nothing while it ran `git fetch --all --prune`, detected gone branches, and resolved each worktree's parent branch — giving no sign it was still working. The spinner covers that whole window and clears just before the per-worktree progress list appears; on the paths where the startup phase fails early it is stopped rather than left spinning. CLI-layer only, mirroring how `wt cleanup` brackets its own fetch.

## 0.10.0

### Minor Changes

- c77368a: `wt update` now understands multiple upstream roots. In a fork with more than one long-lived integration branch (for example `main` plus `core`, each mirroring a different upstream branch), every local branch whose name also exists on the resolved upstream remote is treated as a root: it is synced from its own `<upstream>/<name>` and is never rebased. A feature branch is rebased onto its nearest true-ancestor root — so work built on `core` lands on `core` instead of being mis-rebased onto `main`. A root that exists only on the upstream remote is used as a rebase target via its remote-tracking ref, with no local branch created. Root detection and base resolution use only git data (refs, merge-base, commit-count); no code-hosting API is called.

### Patch Changes

- a8c06c4: `wt update` no longer aborts when the local default branch has diverged from its sync remote. When every local default-branch commit is already present upstream (the squash-merge case), the branch is reset to the remote and the run continues; when there is genuine local work, the branch is left untouched with a warning and feature branches are still rebased. This applies on both the worktree and no-worktree paths, honours a configured upstream remote, guards against discarding a dirty default-branch worktree, and previews the outcome under `--dry-run`.
- e920f26: `wt update` now resolves feature branches' rebase bases with concurrent, bounded git probes instead of one at a time. On a fork that tracks a busy upstream (hundreds of branches under `refs/remotes/<upstream>/*`), the base-resolution phase used to spawn `git merge-base` / `git rev-list` serially for every feature against every candidate root, adding multi-second latency to each run. The independent read-only probes — the per-feature loop and the per-candidate-root probes within a single feature — now run under a fixed concurrency bound. The chosen base for every feature is unchanged (same nearest candidate, same default-first then discovery-order tie-break). One behavioral change beyond scheduling: a feature already fully contained in the default branch no longer short-circuits after the default probe — it now runs the (bounded, concurrent) root/sibling probes too, and still resolves to the default.
- f72b7c4: Fix `wt self-update` failing with "The socket connection was closed unexpectedly". The release-binary download now retries the request (bounded to 5 attempts, with a short escalating backoff) when the underlying Bun `fetch` throws a network/connection error or the release CDN returns a transient status, so a flaky download recovers on a retry instead of breaking the whole command. Deterministic 4xx failures (e.g. a 404 missing asset) still fail fast, while transient 5xx/429 responses are retried like the thrown socket error.
- d463020: `wt remove`: locked worktrees are now reported as a single, calm "skipped" group (count header, per-worktree name, copy-paste `git worktree unlock "<path>"` command, and a re-run hint) instead of one red failure per worktree. A lock is an expected state held by another task, so it no longer reads as a removal error or affects the exit code. Applies to both the single- and multi-worktree paths.
- d9fd2a2: `wt cleanup`: worktrees that git refuses to remove because they are locked are now reported as a single, calm "skipped" group (count header, per-worktree name, copy-paste `git worktree unlock "<path>"` command, and a re-run hint) instead of one red "Failed to remove worktree" error per worktree. A lock is an expected state held by another task, so it no longer counts toward the failure tally and can no longer flip the exit code to partial/failure. Applies to both cleanup removal sites — gone-branch worktrees and non-prunable orphans — and reuses the same locked-group format as `wt remove`.
- 41bb737: Make the `wt self-update` release check retry transient failures. The `api.github.com` "latest release" call behind `wt self-update` (and the background update notifier) was one-shot: a thrown Bun-fetch connection error, a per-attempt timeout, or a transient 5xx/429 broke the command before the download step was even reached. It now retries under the same bounded budget as the binary download (5 attempts, short escalating backoff ≈ 2s), so a flaky release check recovers on a retry. A deterministic non-OK status (any 4xx, including a 403 rate-limit) and a well-formed response missing `tag_name` still fail fast. The retry loop, transient-status predicate, and tagged attempt outcome are extracted into a shared `withRetry` primitive reused by both the metadata call and the download.

## 0.9.0

### Minor Changes

- 27958cc: `wt update` now shows one live progress line per targeted worktree (waiting → rebasing → done/conflict/skipped) instead of a single indeterminate spinner, and rebases independent worktrees concurrently. Concurrency is bounded (default 4) and configurable with a new `--jobs <n>` flag; parent→child ordering, "skip descendants of a failed parent", SIGINT cleanup, and `--dry-run` behavior are all preserved.

### Patch Changes

- 5a960fe: Fix `wt update --dry-run` advancing the default branch. Dry-run now skips the default-branch sync entirely and previews the change ("would be advanced by N commits") instead of fast-forwarding the ref and working tree.
- 414e38a: Fix upstream candidate detection in fork layouts. `resolveUpstream` now excludes the resolved primary remote instead of the literal `origin`, so `wt init`/`wt update` offer the original project (`origin`) as the upstream when the fork is the primary remote.

## Bug Fixes

- suppress stale update notice during self-update

## Bug Fixes

- propose deletion for fully-merged branches without [gone] marker
- wire create-from-remote through resolved remote, harden resolution
- suppress remote-delete prompt for --yes/--non-interactive/--dry-run

## Documentation

- document missing commands and features
- address review

## Features

- support non-origin remotes by resolving remote name from git config

## Miscellaneous

- upgrade actions to Node 24-compatible versions
- update non-major dependencies
- upgrade TypeScript to v6
- surface Windows hint and warn on xattr failure
- address review — guard sync throws, tighten tests

## Refactoring

- dedup hook execution and merge-prefix detection
- preserve divergent fallback per call site
- extract branch-deletion policy into a use case with typed outcomes
- address review — preserve single-path messaging, drop dead surface
- use deleteBranch use case instead of hand-rolled ladder
- handle delete-branch outcomes exhaustively
- address review — cover yes-gate, tighten help text

## Testing

- add real-remote git fixtures (bare remote, tracking clone, unborn HEAD)
- cover every GitPort method with real-git integration tests
- add fake-vs-adapter contract suite for git error codes

## Bug Fixes

- report branch-deletion failures in multi-worktree path
- return Result from isRebaseInProgress and isMergeInProgress
- surface ignored Result failures in destructive paths
- only clean up branches the prompt counted
- make dry-run preview predict the real outcome

## Ci

- verify the binary builds on every push and PR

## Bug Fixes

- keep empty branches cleanup-eligible in cleanup-worktrees
- only prompt to delete positively-merged gone branches

## Refactoring

- split classifyGoneBranch into 4 states (merged/empty/unmerged/dirty)

## Bug Fixes

- check mergedness before removing worktree
- hide unmergeable gone branches from cleanup prompt

## Features

- add classifyGoneBranch use case

## Bug Fixes

- surface actionable error when removing a locked worktree
- invalidate update-check cache after successful update

## Documentation

- describe remote-name semantics and init detection
- document update auto-detection and false opt-out

## Features

- detect target path collision before creating worktree
- add worktree drift detector
- mark drifted worktrees
- report worktree path drift
- add moveWorktree port + adapter
- rename drifted worktrees with --rename
- actionable warning for dirty worktrees skipped in cleanup
- add remote management ports + mergeFFOnly remote param
- upstream remote support for forks
- add getRemoteUrl + setRemoteUrl ports + adapter
- detect remotes and record the real upstream name
- allow upstream to be false (opt-out)
- add setConfigUpstream use case
- auto-detect and persist upstream remote

## Refactoring

- extract shared upstream-detection helper

## Build

- add bun-types as direct devDependency for clean-install typecheck

## Ci

- add typecheck/lint/test workflow for PRs

## Bug Fixes

- retarget stacked branches off gone parents before rebase
- address review feedback for gone-parent retargeting

## Features

- support --local flag and standalone local config

## Bug Fixes

- skip rebase for fully squash-merged and cherry-picked branches
- detect squash-merged and cherry-picked branches as fully merged

## Bug Fixes

- exit 130 on prompt cancellation instead of 0
- gate raw ANSI escapes in multiSpinner behind TTY check
- stub fresh update cache to prevent fire-and-forget refresh leak

## Documentation

- document wt list --json flag and wt update stale branch cleanup

## Features

- formalize exit code semantics (0/1/2/3/130)
- handle SIGINT with per-operation cleanup
- register --verbose and --non-interactive as citty global options
- add --json output mode to wt list
- detect and remove orphaned worktrees
- offer stale branch cleanup after wt update
- support ~/.config/worktree-kit/config.jsonc global defaults
- add wt config show command with field provenance
- add wt doctor health-check command
- handle orphaned and detached-HEAD worktrees
- offer prune for missing-worktree-directory issues
- split --yes from --non-interactive for destructive ops
- add wt sync command to apply config changes to existing worktrees
- skip already-merged commit prefix to avoid spurious conflicts

## Performance

- skip update check on --help, --version, and non-TTY

## Refactoring

- extract runCommand wrapper for unified error handling
- validate command args with valibot schemas
- remove scattered Record casts from deep-merge
- move command files under src/cli/commands/

## Bug Fixes

- prevent self-update hang and surface download progress

## Bug Fixes

- detect existing local and remote branches from -b flag

## Features

- notify on CLI startup when a newer version is available

## Bug Fixes

- fix empty version in release workflow

## Documentation

- document local config overrides

## Features

- symlink root config into new worktrees
- add on-conflict hook for automatic rebase conflict resolution
- support .worktreekit.local.jsonc for per-user config overrides
- add self-update command

## Miscellaneous

- add .worktreekit.jsonc to .gitignore

## Style

- format update-worktrees with biome

## Bug Fixes

- render hook failures inline with worktree branch line

## Bug Fixes

- pass force flag to git worktree remove

## Documentation

- document negation patterns and update config examples

## Features

- add post-update hook support
- warn when symlink target is a git-tracked path
- support negation patterns in copy and symlinks config

## Miscellaneous

- remove bun.lock from repository

## Refactoring

- extract uniqueBy array dedup utility

## Bug Fixes

- handle trailing commas in JSONC and warn on config load failure

## Bug Fixes

- return defaultBranch when branch has zero diverged commits
- clarify branch deletion warnings and add interactive force-delete prompt

## Documentation

- add $schema to config example and update migration section

## Features

- add JSONC support infrastructure
- migrate config format to .worktreekit.jsonc
- add JSON Schema and $schema support

## Testing

- add JSONC migration tests and update docs

## Bug Fixes

- enable glob matching for dotfiles in copy config
- ignore remote branch deletion when ref does not exist
- include default branch as parent candidate in findParentBranch
- pass --force flag to git worktree remove

## Documentation

- add global options section and update command docs
- add symlinks configuration to README

## Features

- add --dry-run flag to wt create
- show spinner during worktrees directory cleanup
- multi-select worktrees for batch deletion
- enhance cleanup logic to handle unique commits before force deletion
- add --non-interactive flag and WT_NON_INTERACTIVE env variable
- add parallel multi-spinner for bulk worktree removal
- add symlinks config for sharing files from root repo

## Refactoring

- consolidate branch deletion into single status message

## Bug Fixes

- filter out release and bump commits from notes
- resolve rootDir relative to main worktree root

## Documentation

- comprehensively update README with all current features

## Features

- add pre-remove hooks support
- add fetch, merge, rebase, and dirty-check methods to GitPort
- add updateWorktrees use case
- add wt update CLI command
- add per-command config sections for create and remove
- add resolve-params module for flag > config > interactive pattern
- add --delete-remote-branch flag to wt remove
- add fetchPrune and listGoneBranches methods to GitPort
- add cleanupWorktrees use case
- add wt cleanup command
- use WIP commit for dirty worktrees and drop --no-rebase flag
- add --dry-run flag to wt update
- add --dry-run flag to wt remove, unify flag description
- add getMergeBase and getCommitCount to GitPort
- detect parent branch via merge-base for correct rebase order
- support `wt update [branch]` to update a specific subtree

## Refactoring

- use resolve-params for create and remove
- drop --no-delete-branch flag and parseBooleanFlag

## Style

- fix biome formatting in test

## Features

- add isDirectory and copyDirectory to FilesystemPort
- support directory copying in copy config
- add glob method to FilesystemPort
- support glob patterns in copy config

## Features

- add defaultBase config and source branch support
- implement getDefaultBranch and baseBranch in worktree creation
- pass baseBranch through to git and update init defaults
- prompt for source branch when creating new branch

## Testing

- add tests for defaultBase schema validation

## Features

- use wt-preview command instead of replacing wt
- add main and current badges to worktree list
- prompt to remove empty worktrees directory after last worktree removed
- show remote branches when creating worktree
- add "Remove all" option to remove command
- move "Create new branch" option to top of branch list
- sort branches by commit date (newest first)
- group remote branches in separate submenu
- automate release workflow with git-cliff

## Miscellaneous

- add \*.local pattern to gitignore

## Bug Fixes

- read version from package.json instead of hardcoded value
- safely remove only dev symlinks in clean script

## Features

- add progress spinner to remove command
- prompt to delete branch when removing worktree

## Documentation

- add GitHub Sponsors funding configuration

## Features

- add interactive mode to create command

## Documentation

- add README and project instructions
- update README to match current implementation

## Features

- add CLI entrypoint with basic routing
- add runtime dependencies
- add Result type for error handling
- add domain layer with entities, ports, and schemas
- add infrastructure layer with adapters and container
- add application layer with use case stubs
- wire CLI commands with citty and composition root
- add test utilities and fakes for unit testing
- replace config schema with rootDir and copy fields
- implement loadConfig and initConfig use cases
- implement Git adapter worktree operations
- implement listWorktrees use case
- add preview and clean scripts for local CLI publishing
- implement createWorktree use case
- add select method to UiPort
- implement removeWorktree use case
- add remove command to CLI
- add branchExists method and support new branch creation in worktrees
- add notification system for use case feedback
- warn when config not found in wt create
- show worktree path in create success message
- read config from main worktree instead of current directory
- add ShellPort interface for command execution
- add hooks configuration to config schema
- add hooks property to WorktreeConfig entity
- add runHooks use case for post-create commands
- add BunShellAdapter for command execution
- run post-create hooks after worktree creation
- wire ShellPort into container and create command
- add SpinnerHandle interface to UiPort
- implement createSpinner in ClackUiAdapter
- add progress spinners to create command
- add LoggerPort interface for verbose logging
- add ConsoleLoggerAdapter for verbose output
- wire LoggerPort into container and adapters
- add --verbose flag and WT_VERBOSE env support
- add release build script and GitHub workflow
- add installation scripts for all platforms

## Miscellaneous

- initial project setup

## Refactoring

- return data instead of executing in createWorktree

## Testing

- add unit tests across all layers
- add FakeShell test utility
- add noop logger for adapter tests
