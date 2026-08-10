import { describe, expect, test } from "bun:test";
import { Semaphore } from "./semaphore.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Semaphore", () => {
	test("allows up to `max` holders at once and queues the rest", async () => {
		const sem = new Semaphore(2);
		let active = 0;
		let peak = 0;

		const task = async () => {
			await sem.acquire();
			active += 1;
			peak = Math.max(peak, active);
			await tick();
			active -= 1;
			sem.release();
		};

		await Promise.all([task(), task(), task(), task(), task()]);

		expect(peak).toBe(2);
	});

	test("a queued acquirer resumes only after a release", async () => {
		const sem = new Semaphore(1);
		const order: string[] = [];

		await sem.acquire();
		order.push("first-acquired");

		let secondAcquired = false;
		const second = sem.acquire().then(() => {
			secondAcquired = true;
			order.push("second-acquired");
		});

		await tick();
		// The second acquire is blocked until the first slot is released.
		expect(secondAcquired).toBe(false);

		sem.release();
		await second;

		expect(secondAcquired).toBe(true);
		expect(order).toEqual(["first-acquired", "second-acquired"]);
	});

	test("release hands the slot to waiters in FIFO order", async () => {
		const sem = new Semaphore(1);
		const order: number[] = [];

		await sem.acquire();

		const w1 = sem.acquire().then(() => order.push(1));
		const w2 = sem.acquire().then(() => order.push(2));
		const w3 = sem.acquire().then(() => order.push(3));

		sem.release(); // → w1
		await w1;
		sem.release(); // → w2
		await w2;
		sem.release(); // → w3
		await w3;

		expect(order).toEqual([1, 2, 3]);
	});
});
