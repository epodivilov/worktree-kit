---
"worktree-kit": patch
---

`wt remove`: locked worktrees are now reported as a single, calm "skipped" group (count header, per-worktree name, copy-paste `git worktree unlock "<path>"` command, and a re-run hint) instead of one red failure per worktree. A lock is an expected state held by another task, so it no longer reads as a removal error or affects the exit code. Applies to both the single- and multi-worktree paths.
