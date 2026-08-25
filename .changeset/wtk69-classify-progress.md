---
"worktree-kit": patch
---

`wt update` now shows a `Classifying gone branches (X of N)…` spinner while it classifies stale branches with gone remotes. Previously, after the per-worktree rebase list finished and the root-sync summary printed, the command went silent again for several seconds while it ran `isDirty`, `getCommitCount`, and `isFullyMerged`'s patch-id / cherry-pick detection for each stale branch — with the terminal already looking finished, giving no sign real work was still happening. The spinner covers that window with a running count and stops before the gone-branch list, cleanup confirm prompt, or outro. It only appears when there is at least one stale branch to classify. CLI-layer only, mirroring the existing WTK-67 fetch/analysis phase spinner.
