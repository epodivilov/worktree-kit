---
"worktree-kit": patch
---

Fix `wt self-update` failing with "The socket connection was closed unexpectedly". The release-binary download now retries the request (bounded to 5 attempts, with a short escalating backoff) when the underlying Bun `fetch` throws a network/connection error, so a transient failure on the initial github.com redirect recovers on a retry instead of breaking the whole command. Deterministic HTTP failures (e.g. a 404 missing asset) still fail fast without retrying.
