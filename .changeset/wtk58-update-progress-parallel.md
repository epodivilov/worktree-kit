---
"worktree-kit": minor
---

`wt update` now shows one live progress line per targeted worktree (waiting → rebasing → done/conflict/skipped) instead of a single indeterminate spinner, and rebases independent worktrees concurrently. Concurrency is bounded (default 4) and configurable with a new `--jobs <n>` flag; parent→child ordering, "skip descendants of a failed parent", SIGINT cleanup, and `--dry-run` behavior are all preserved.
