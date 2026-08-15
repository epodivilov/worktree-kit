import type { Result } from "../shared/result.ts";
import { isTransientStatus, type RetryOutcome, withRetry } from "../shared/retry.ts";

const REPO = "epodivilov/worktree-kit";

export interface LatestRelease {
	tag: string;
	version: string;
}

export interface FetchLatestVersionDeps {
	/** Injectable for tests; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Injectable backoff sleep; tests pass a no-op to avoid real timers. */
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Fetches the latest release from `api.github.com`, retrying transient failures.
 *
 * A single attempt is classified as `ok | retriable | fatal` and driven through
 * the shared {@link withRetry}: a thrown network/connection error or per-attempt
 * timeout, a transient 5xx/429, or a body-read failure are retried; a
 * deterministic non-OK status (any 4xx, including a 403 rate-limit) or a
 * well-formed response missing `tag_name` fail fast.
 */
export async function fetchLatestVersion(deps: FetchLatestVersionDeps = {}): Promise<Result<LatestRelease>> {
	const { fetchImpl = fetch, sleep } = deps;

	const attempt = async (): Promise<RetryOutcome<LatestRelease>> => {
		let res: Response;
		try {
			res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
				headers: { Accept: "application/vnd.github+json" },
				// Per-attempt timeout: a hung attempt aborts and then counts as a
				// retriable failed attempt (a TimeoutError is a thrown reject).
				signal: AbortSignal.timeout(15_000),
			});
		} catch (err) {
			const error =
				err instanceof Error && err.name === "TimeoutError"
					? new Error("GitHub API timeout")
					: err instanceof Error
						? err
						: new Error(String(err));
			return { kind: "retriable", error };
		}

		if (!res.ok) {
			const error = new Error(`GitHub API error: ${res.status} ${res.statusText}`);
			return isTransientStatus(res.status) ? { kind: "retriable", error } : { kind: "fatal", error };
		}

		let data: { tag_name?: string };
		try {
			data = (await res.json()) as { tag_name?: string };
		} catch (err) {
			// A body read/parse throw conflates a mid-read connection drop (transient)
			// with malformed JSON (deterministic). A genuinely malformed GitHub release
			// payload is effectively impossible, so treat the throw as retriable.
			return {
				kind: "retriable",
				error: err instanceof Error ? err : new Error("Failed to parse GitHub API response"),
			};
		}

		const tag = data.tag_name;
		if (!tag) {
			// A successfully parsed response missing `tag_name` is deterministic.
			return { kind: "fatal", error: new Error("GitHub API response missing tag_name") };
		}
		const version = tag.startsWith("v") ? tag.slice(1) : tag;
		return { kind: "ok", value: { tag, version } };
	};

	return withRetry(attempt, { sleep });
}
