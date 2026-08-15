import { describe, expect, test } from "bun:test";
import { Result as R } from "./result.ts";
import { DEFAULT_MAX_ATTEMPTS, defaultBackoffMs, isTransientStatus, type RetryOutcome, withRetry } from "./retry.ts";

const noSleep = async () => {};

describe("withRetry", () => {
	test("resolves ok after N calls when the attempt is retriable N-1 times then ok", async () => {
		let calls = 0;
		const attempt = async (): Promise<RetryOutcome<string>> => {
			calls += 1;
			if (calls < 3) return { kind: "retriable", error: new Error("transient") };
			return { kind: "ok", value: "done" };
		};

		const result = await withRetry(attempt, { sleep: noSleep });

		expect(R.isOk(result)).toBe(true);
		if (R.isOk(result)) {
			expect(result.data).toBe("done");
		}
		expect(calls).toBe(3);
	});

	test("an always-retriable attempt fails after exactly maxAttempts with the last attempt's error", async () => {
		let calls = 0;
		const attempt = async (): Promise<RetryOutcome<string>> => {
			calls += 1;
			return { kind: "retriable", error: new Error(`fail-${calls}`) };
		};

		const result = await withRetry(attempt, { sleep: noSleep, maxAttempts: 4 });

		expect(R.isErr(result)).toBe(true);
		if (R.isErr(result)) {
			expect(result.error.message).toBe("fail-4");
		}
		expect(calls).toBe(4);
	});

	test("defaults to DEFAULT_MAX_ATTEMPTS when maxAttempts is not given", async () => {
		let calls = 0;
		const attempt = async (): Promise<RetryOutcome<string>> => {
			calls += 1;
			return { kind: "retriable", error: new Error("boom") };
		};

		await withRetry(attempt, { sleep: noSleep });

		expect(calls).toBe(DEFAULT_MAX_ATTEMPTS);
	});

	test("DEFAULT_MAX_ATTEMPTS is pinned to 5 (the documented ~2s retry budget)", () => {
		expect(DEFAULT_MAX_ATTEMPTS).toBe(5);
	});

	test("a fatal attempt returns immediately with no retry", async () => {
		let calls = 0;
		const attempt = async (): Promise<RetryOutcome<string>> => {
			calls += 1;
			return { kind: "fatal", error: new Error("deterministic") };
		};

		const result = await withRetry(attempt, { sleep: noSleep });

		expect(R.isErr(result)).toBe(true);
		if (R.isErr(result)) {
			expect(result.error.message).toBe("deterministic");
		}
		expect(calls).toBe(1);
	});

	test("backs off with the linear attempt*200 formula between attempts (pins the ~2s budget)", async () => {
		const slept: number[] = [];
		const sleep = async (ms: number) => {
			slept.push(ms);
		};
		const attempt = async (): Promise<RetryOutcome<string>> => ({ kind: "retriable", error: new Error("x") });

		await withRetry(attempt, { sleep, maxAttempts: 5 });

		// 4 sleeps between 5 attempts: 200 + 400 + 600 + 800 ≈ 2s total budget.
		expect(slept).toEqual([200, 400, 600, 800]);
	});
});

describe("defaultBackoffMs", () => {
	test("is linear: attempt * 200", () => {
		expect(defaultBackoffMs(1)).toBe(200);
		expect(defaultBackoffMs(2)).toBe(400);
		expect(defaultBackoffMs(3)).toBe(600);
		expect(defaultBackoffMs(4)).toBe(800);
	});
});

describe("isTransientStatus", () => {
	test("429 and 5xx are transient", () => {
		expect(isTransientStatus(429)).toBe(true);
		expect(isTransientStatus(500)).toBe(true);
		expect(isTransientStatus(503)).toBe(true);
	});

	test("4xx (except 429) and 2xx/3xx are not transient", () => {
		expect(isTransientStatus(400)).toBe(false);
		expect(isTransientStatus(403)).toBe(false);
		expect(isTransientStatus(404)).toBe(false);
		expect(isTransientStatus(200)).toBe(false);
		expect(isTransientStatus(301)).toBe(false);
	});
});
