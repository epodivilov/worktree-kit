---
"worktree-kit": patch
---

Fix upstream candidate detection in fork layouts. `resolveUpstream` now excludes the resolved primary remote instead of the literal `origin`, so `wt init`/`wt update` offer the original project (`origin`) as the upstream when the fork is the primary remote.
