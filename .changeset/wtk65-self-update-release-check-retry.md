---
"worktree-kit": patch
---

Make the `wt self-update` release check retry transient failures. The `api.github.com` "latest release" call behind `wt self-update` (and the background update notifier) was one-shot: a thrown Bun-fetch connection error, a per-attempt timeout, or a transient 5xx/429 broke the command before the download step was even reached. It now retries under the same bounded budget as the binary download (5 attempts, short escalating backoff ≈ 2s), so a flaky release check recovers on a retry. A deterministic non-OK status (any 4xx, including a 403 rate-limit) and a well-formed response missing `tag_name` still fail fast. The retry loop, transient-status predicate, and tagged attempt outcome are extracted into a shared `withRetry` primitive reused by both the metadata call and the download.
