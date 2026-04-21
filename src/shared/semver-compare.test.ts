import { describe, expect, test } from "bun:test";
import { isNewer } from "./semver-compare.ts";

describe("isNewer", () => {
	test("returns false for equal versions", () => {
		expect(isNewer("1.2.3", "1.2.3")).toBe(false);
	});

	test("returns true when remote major is higher", () => {
		expect(isNewer("2.0.0", "1.9.9")).toBe(true);
	});

	test("returns true when remote minor is higher", () => {
		expect(isNewer("1.3.0", "1.2.9")).toBe(true);
	});

	test("returns true when remote patch is higher", () => {
		expect(isNewer("1.2.4", "1.2.3")).toBe(true);
	});

	test("compares numerically, not lexicographically", () => {
		expect(isNewer("0.10.0", "0.9.0")).toBe(true);
		expect(isNewer("0.9.0", "0.10.0")).toBe(false);
	});

	test("returns false when current is newer", () => {
		expect(isNewer("1.0.0", "2.0.0")).toBe(false);
	});

	test("strips prerelease/build metadata when parsing", () => {
		expect(isNewer("1.2.4-beta.1", "1.2.3")).toBe(true);
		expect(isNewer("1.2.3+build.5", "1.2.3")).toBe(false);
	});

	test("returns false for unparseable versions", () => {
		expect(isNewer("not-a-version", "1.0.0")).toBe(false);
		expect(isNewer("1.0.0", "also-bad")).toBe(false);
	});
});
