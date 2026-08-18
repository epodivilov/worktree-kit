---
"worktree-kit": patch
---

`wt update` now shows a `Fetching and analyzing worktrees...` spinner during its startup phase instead of leaving the terminal silent for several seconds. Previously the command printed its intro banner and then nothing while it ran `git fetch --all --prune`, detected gone branches, and resolved each worktree's parent branch — giving no sign it was still working. The spinner covers that whole window and clears just before the per-worktree progress list appears; on the paths where the startup phase fails early it is stopped rather than left spinning. CLI-layer only, mirroring how `wt cleanup` brackets its own fetch.
