import { Result as R, type Result } from "./result.ts";

/**
 * Outcome of a single attempt driven by {@link withRetry}.
 *
 * - `ok` carries the attempt's value and stops the loop successfully.
 * - `retriable` is a transient failure (a thrown network/connection error, a
 *   per-attempt timeout, a mid-stream drop, or a transient 5xx/429): the loop
 *   backs off and re-attempts until the bound.
 * - `fatal` is deterministic (a non-transient HTTP status, a well-formed but
 *   invalid payload, …): the loop returns it immediately with no retry.
 */
export type RetryOutcome<T> =
	| { kind: "ok"; value: T }
	| { kind: "retriable"; error: Error }
	| { kind: "fatal"; error: Error };

/**
 * Default number of attempts before {@link withRetry} gives up.
 *
 * Bun's `fetch` to github.com intermittently throws a connection-level error
 * (WTK-59) or returns a transient 5xx/429; each self-update call is a fresh
 * one-shot request, so a bounded retry lets a transient failure recover instead
 * of failing the whole command. Both self-update call sites (the release-check
 * fetch and the binary download) reuse this single bound.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Linear escalating backoff: 200ms per prior attempt (200/400/600/800). The
 * worst case across all retries stays bounded (≈2s) so an interactive command
 * cannot hang for minutes.
 */
export function defaultBackoffMs(attempt: number): number {
	return attempt * 200;
}

/**
 * A 5xx or 429 HTTP status is transient — the same recoverable class as a thrown
 * socket error, just surfaced as a status, so it is retried. Every other non-OK
 * status (a 4xx, including a 403 rate-limit that a retry inside the window will
 * not clear) is deterministic and must fail fast.
 */
export function isTransientStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

export interface RetryOptions {
	maxAttempts?: number;
	backoffMs?: (attempt: number) => number;
	/** Injectable backoff sleep; tests pass a no-op to avoid real timers. */
	sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drives `attempt` under a bounded retry with backoff: an `ok` outcome resolves
 * with its value, a `fatal` outcome returns its error immediately, and a
 * `retriable` outcome backs off and re-attempts until `maxAttempts`, then
 * returns the last attempt's error (never an infinite loop).
 */
export async function withRetry<T>(
	attempt: () => Promise<RetryOutcome<T>>,
	opts: RetryOptions = {},
): Promise<Result<T>> {
	const { maxAttempts = DEFAULT_MAX_ATTEMPTS, backoffMs = defaultBackoffMs, sleep = defaultSleep } = opts;

	for (let n = 1; ; n++) {
		const outcome = await attempt();
		if (outcome.kind === "ok") return R.ok(outcome.value);
		if (outcome.kind === "fatal") return R.err(outcome.error);
		if (n >= maxAttempts) return R.err(outcome.error);
		await sleep(backoffMs(n));
	}
}
