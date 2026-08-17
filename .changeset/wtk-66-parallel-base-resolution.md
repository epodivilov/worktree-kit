---
"worktree-kit": patch
---

`wt update` now resolves feature branches' rebase bases with concurrent, bounded git probes instead of one at a time. On a fork that tracks a busy upstream (hundreds of branches under `refs/remotes/<upstream>/*`), the base-resolution phase used to spawn `git merge-base` / `git rev-list` serially for every feature against every candidate root, adding multi-second latency to each run. The independent read-only probes — the per-feature loop and the per-candidate-root probes within a single feature — now run under a fixed concurrency bound. The chosen base for every feature is unchanged (same nearest candidate, same default-first then discovery-order tie-break). One behavioral change beyond scheduling: a feature already fully contained in the default branch no longer short-circuits after the default probe — it now runs the (bounded, concurrent) root/sibling probes too, and still resolves to the default.
