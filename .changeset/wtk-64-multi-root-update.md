---
"worktree-kit": minor
---

`wt update` now understands multiple upstream roots. In a fork with more than one long-lived integration branch (for example `main` plus `core`, each mirroring a different upstream branch), every local branch whose name also exists on the resolved upstream remote is treated as a root: it is synced from its own `<upstream>/<name>` and is never rebased. A feature branch is rebased onto its nearest true-ancestor root — so work built on `core` lands on `core` instead of being mis-rebased onto `main`. A root that exists only on the upstream remote is used as a rebase target via its remote-tracking ref, with no local branch created. Root detection and base resolution use only git data (refs, merge-base, commit-count); no code-hosting API is called.
