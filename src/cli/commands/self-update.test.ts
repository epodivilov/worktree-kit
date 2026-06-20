import { describe, expect, test } from "bun:test";
import { Result as R } from "../../shared/result.ts";
import {
	detectBinaryName,
	type QuarantineRemover,
	tryRemoveMacosQuarantine,
	WINDOWS_UNSUPPORTED_MESSAGE,
} from "./self-update.ts";

describe("detectBinaryName", () => {
	test("win32 → returns Windows-specific error pointing at install.ps1", () => {
		const result = detectBinaryName("win32", "x64");
		expect(R.isErr(result)).toBe(true);
		if (R.isErr(result)) {
			expect(result.error.message).toBe(WINDOWS_UNSUPPORTED_MESSAGE);
		}
	});

	test("win32 message does not look like the generic unsupported-platform fallback", () => {
		const result = detectBinaryName("win32", "x64");
		expect(R.isErr(result)).toBe(true);
		if (R.isErr(result)) {
			expect(result.error.message).not.toMatch(/^Unsupported platform:/);
			expect(result.error.message).toContain("install.ps1");
		}
	});

	test("other unsupported platforms keep the generic message", () => {
		// freebsd is not in the supported set and is not win32, so it must fall through
		// to the generic "Unsupported platform: …" branch.
		const result = detectBinaryName("freebsd" as NodeJS.Platform, "x64");
		expect(R.isErr(result)).toBe(true);
		if (R.isErr(result)) {
			expect(result.error.message).toBe("Unsupported platform: freebsd/x64");
		}
	});

	test("unsupported arch on a supported os keeps the generic message", () => {
		const result = detectBinaryName("linux", "ia32");
		expect(R.isErr(result)).toBe(true);
		if (R.isErr(result)) {
			expect(result.error.message).toBe("Unsupported platform: linux/ia32");
		}
	});

	test("darwin/arm64 → wt-darwin-arm64", () => {
		const result = detectBinaryName("darwin", "arm64");
		expect(R.isOk(result)).toBe(true);
		if (R.isOk(result)) {
			expect(result.data).toBe("wt-darwin-arm64");
		}
	});

	test("linux/x64 → wt-linux-x64", () => {
		const result = detectBinaryName("linux", "x64");
		expect(R.isOk(result)).toBe(true);
		if (R.isOk(result)) {
			expect(result.data).toBe("wt-linux-x64");
		}
	});
});

describe("tryRemoveMacosQuarantine", () => {
	test("remover ok → no warning", () => {
		const warnings: string[] = [];
		const remover: QuarantineRemover = () => R.ok(undefined);

		tryRemoveMacosQuarantine("/path/to/wt", {
			remover,
			warn: (m) => warnings.push(m),
		});

		expect(warnings).toEqual([]);
	});

	test("remover errs → warning logged, no throw", () => {
		const warnings: string[] = [];
		const remover: QuarantineRemover = () => R.err(new Error("xattr: command not found"));

		expect(() =>
			tryRemoveMacosQuarantine("/path/to/wt", {
				remover,
				warn: (m) => warnings.push(m),
			}),
		).not.toThrow();

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("xattr: command not found");
		expect(warnings[0]).toContain("/path/to/wt");
	});

	test("remover errs with non-Error → message still surfaces", () => {
		const warnings: string[] = [];
		const remover: QuarantineRemover = () => R.err(new Error("exited with code 1"));

		tryRemoveMacosQuarantine("/usr/local/bin/wt", {
			remover,
			warn: (m) => warnings.push(m),
		});

		expect(warnings[0]).toContain("exited with code 1");
		expect(warnings[0]).toContain("/usr/local/bin/wt");
	});
});
