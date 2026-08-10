---
"worktree-kit": patch
---

Fix `wt update --dry-run` advancing the default branch. Dry-run now skips the default-branch sync entirely and previews the change ("would be advanced by N commits") instead of fast-forwarding the ref and working tree.
