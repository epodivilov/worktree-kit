import { describe, expect, test } from "bun:test";
import { Result } from "./result.ts";

describe("Result", () => {
	test("ok creates a success result with data", () => {
		const r = Result.ok(42);
		expect(r).toEqual({ success: true, data: 42 });
	});

	test("err creates a failure result with error", () => {
		const r = Result.err("bad");
		expect(r).toEqual({ success: false, error: "bad" });
	});

	test("isOk returns true for ok, false for err", () => {
		expect(Result.isOk(Result.ok(1))).toBe(true);
		expect(Result.isOk(Result.err("x"))).toBe(false);
	});

	test("isErr returns true for err, false for ok", () => {
		expect(Result.isErr(Result.err("x"))).toBe(true);
		expect(Result.isErr(Result.ok(1))).toBe(false);
	});
});
