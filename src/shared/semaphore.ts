/**
 * A minimal counting semaphore for bounding concurrency in-process. No third-party
 * dependency is pulled in for this; the whole primitive is a permit counter plus a
 * FIFO queue of waiters.
 *
 * Usage:
 * ```ts
 * const sem = new Semaphore(4);
 * await sem.acquire();
 * try {
 *   // ... bounded section ...
 * } finally {
 *   sem.release();
 * }
 * ```
 */
export class Semaphore {
	private permits: number;
	private readonly waiters: Array<() => void> = [];

	constructor(max: number) {
		if (!Number.isInteger(max) || max < 1) {
			throw new Error(`Semaphore size must be a positive integer, got ${max}`);
		}
		this.permits = max;
	}

	/** Resolves once a permit is available. Each `acquire` must be paired with one `release`. */
	acquire(): Promise<void> {
		if (this.permits > 0) {
			this.permits -= 1;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.waiters.push(resolve);
		});
	}

	/** Returns a permit, handing it directly to the next waiter (FIFO) if any. */
	release(): void {
		const next = this.waiters.shift();
		if (next) {
			next();
		} else {
			this.permits += 1;
		}
	}
}

/**
 * Runs `fn` while holding a single permit from `sem`, releasing it even if `fn`
 * throws. The building block for bounding a batch of independent async tasks:
 * `Promise.all(items.map((x) => withPermit(sem, () => work(x))))` caps how many run
 * at once without any task holding a permit while it waits for another.
 */
export async function withPermit<T>(sem: Semaphore, fn: () => Promise<T>): Promise<T> {
	await sem.acquire();
	try {
		return await fn();
	} finally {
		sem.release();
	}
}
