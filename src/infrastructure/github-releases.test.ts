import { describe, expect, test } from "bun:test";
import { Result as R } from "../shared/result.ts";
import { DEFAULT_MAX_ATTEMPTS } from "../shared/retry.ts";
import { fetchLatestVersion } from "./github-releases.ts";

const noSleep = async () => {};

const SOCKET_ERROR = "The socket connection was closed unexpectedly";

function releaseResponse(tag: string): Response {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: new Headers(),
		json: async () => ({ tag_name: tag }),
	} as unknown as Response;
}

function statusResponse(status: number, statusText: string): Response {
	return {
		ok: false,
		status,
		statusText,
		headers: new Headers(),
		json: async () => ({}),
	} as unknown as Response;
}

function timeoutError(): Error {
	const e = new Error("The operation timed out");
	e.name = "TimeoutError";
	return e;
}

describe("fetchLatestVersion retry", () => {
	test("R1: retries a thrown connection error then returns the parsed release", async () => {
		const throwsFirst = 2;
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			if (calls <= throwsFirst) throw new Error(SOCKET_ERROR);
			return releaseResponse("v1.4.0");
		}) as unknown as typeof fetch;

		const result = await fetchLatestVersion({ fetchImpl, sleep: noSleep });

		expect(R.isOk(result)).toBe(true);
		if (R.isOk(result)) {
			expect(result.data.tag).toBe("v1.4.0");
			expect(result.data.version).toBe("1.4.0");
		}
		expect(calls).toBe(throwsFirst + 1);
	});

	test("R1 (timeout): retries a per-attempt TimeoutError then succeeds", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			if (calls === 1) throw timeoutError();
			return releaseResponse("v2.0.0");
		}) as unknown as typeof fetch;

		const result = await fetchLatestVersion({ fetchImpl, sleep: noSleep });

		expect(R.isOk(result)).toBe(true);
		if (R.isOk(result)) {
			expect(result.data.version).toBe("2.0.0");
		}
		expect(calls).toBe(2);
	});

	test("R2 (transient): retries a 503 then returns the release", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			if (calls === 1) return statusResponse(503, "Service Unavailable");
			return releaseResponse("v1.0.1");
		}) as unknown as typeof fetch;

		const result = await fetchLatestVersion({ fetchImpl, sleep: noSleep });

		expect(R.isOk(result)).toBe(true);
		if (R.isOk(result)) {
			expect(result.data.version).toBe("1.0.1");
		}
		expect(calls).toBeGreaterThan(1);
	});

	test("R2 (fail-fast): a 404 fails after a single fetch — no retry", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return statusResponse(404, "Not Found");
		}) as unknown as typeof fetch;

		const result = await fetchLatestVersion({ fetchImpl, sleep: noSleep });

		expect(R.isErr(result)).toBe(true);
		if (R.isErr(result)) {
			expect(result.error.message).toContain("404");
		}
		expect(calls).toBe(1);
	});

	test("R2 (fail-fast): a 403 rate-limit fails after a single fetch — no retry", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return statusResponse(403, "Forbidden");
		}) as unknown as typeof fetch;

		const result = await fetchLatestVersion({ fetchImpl, sleep: noSleep });

		expect(R.isErr(result)).toBe(true);
		if (R.isErr(result)) {
			expect(result.error.message).toContain("403");
		}
		expect(calls).toBe(1);
	});

	test("R3 (body throw): retries a json() read failure then succeeds", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			if (calls === 1) {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					headers: new Headers(),
					json: async () => {
						throw new Error("connection reset mid-read");
					},
				} as unknown as Response;
			}
			return releaseResponse("v3.1.4");
		}) as unknown as typeof fetch;

		const result = await fetchLatestVersion({ fetchImpl, sleep: noSleep });

		expect(R.isOk(result)).toBe(true);
		if (R.isOk(result)) {
			expect(result.data.version).toBe("3.1.4");
		}
		expect(calls).toBe(2);
	});

	test("R3 (malformed): a 200 with no tag_name fails after a single fetch — no retry", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers(),
				json: async () => ({ name: "no tag here" }),
			} as unknown as Response;
		}) as unknown as typeof fetch;

		const result = await fetchLatestVersion({ fetchImpl, sleep: noSleep });

		expect(R.isErr(result)).toBe(true);
		expect(calls).toBe(1);
	});

	test("R4 (give up): every attempt throws → error after exactly DEFAULT_MAX_ATTEMPTS", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			throw new Error(SOCKET_ERROR);
		}) as unknown as typeof fetch;

		const result = await fetchLatestVersion({ fetchImpl, sleep: noSleep });

		expect(R.isErr(result)).toBe(true);
		if (R.isErr(result)) {
			expect(result.error.message).toContain("socket connection");
		}
		expect(calls).toBe(DEFAULT_MAX_ATTEMPTS);
	});
});
