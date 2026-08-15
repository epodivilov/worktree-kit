---
"worktree-kit": patch
---

`wt cleanup`: worktrees that git refuses to remove because they are locked are now reported as a single, calm "skipped" group (count header, per-worktree name, copy-paste `git worktree unlock "<path>"` command, and a re-run hint) instead of one red "Failed to remove worktree" error per worktree. A lock is an expected state held by another task, so it no longer counts toward the failure tally and can no longer flip the exit code to partial/failure. Applies to both cleanup removal sites — gone-branch worktrees and non-prunable orphans — and reuses the same locked-group format as `wt remove`.
