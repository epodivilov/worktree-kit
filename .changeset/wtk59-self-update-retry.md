---
"worktree-kit": patch
---

Fix `wt self-update` failing with "The socket connection was closed unexpectedly". The release-binary download now retries the request (bounded to 5 attempts, with a short escalating backoff) when the underlying Bun `fetch` throws a network/connection error or the release CDN returns a transient status, so a flaky download recovers on a retry instead of breaking the whole command. Deterministic 4xx failures (e.g. a 404 missing asset) still fail fast, while transient 5xx/429 responses are retried like the thrown socket error.
