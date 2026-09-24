---
"worktree-kit": patch
---

`wt update` now presents rebase conflicts once as a compact, actionable summary with each root branch's target and affected descendants. It no longer prints stale Git rebase advice after aborting the rebase, and unresolved updates end with the short `Update incomplete` error.
