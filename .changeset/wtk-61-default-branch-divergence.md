---
"worktree-kit": patch
---

`wt update` no longer aborts when the local default branch has diverged from its sync remote. When every local default-branch commit is already present upstream (the squash-merge case), the branch is reset to the remote and the run continues; when there is genuine local work, the branch is left untouched with a warning and feature branches are still rebased. This applies on both the worktree and no-worktree paths, honours a configured upstream remote, guards against discarding a dirty default-branch worktree, and previews the outcome under `--dry-run`.
