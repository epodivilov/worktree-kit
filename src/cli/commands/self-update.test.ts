import { describe, expect, test } from "bun:test";
import { Result as R } from "../../shared/result.ts";
import {
	detectBinaryName,
	interpretXattrRemoval,
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

	test("darwin/x64 → wt-darwin-x64", () => {
		const result = detectBinaryName("darwin", "x64");
		expect(R.isOk(result)).toBe(true);
		if (R.isOk(result)) {
			expect(result.data).toBe("wt-darwin-x64");
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

describe("interpretXattrRemoval", () => {
	test("exit 0 → ok", () => {
		expect(R.isOk(interpretXattrRemoval(0, ""))).toBe(true);
	});

	test("missing attribute (No such xattr) → ok, not a failure", () => {
		// The binary is fetched over HTTP, so macOS never stamps it with the
		// quarantine attribute. `xattr -d` then exits non-zero with this message,
		// which must NOT surface as a warning.
		const stderr = "xattr: /Users/me/.local/bin/wt: No such xattr: com.apple.quarantine";
		expect(R.isOk(interpretXattrRemoval(1, stderr))).toBe(true);
	});

	test("missing attribute (ENOATTR) → ok", () => {
		expect(R.isOk(interpretXattrRemoval(1, "xattr: [Errno 93] ENOATTR"))).toBe(true);
	});

	test("missing attribute (Attribute not found) → ok", () => {
		expect(R.isOk(interpretXattrRemoval(1, "Attribute not found"))).toBe(true);
	});

	test("genuine failure → err with stderr message", () => {
		const result = interpretXattrRemoval(1, "xattr: command not found");
		expect(R.isErr(result)).toBe(true);
		if (R.isErr(result)) {
			expect(result.error.message).toBe("xattr: command not found");
		}
	});

	test("non-zero exit with empty stderr → err mentions the exit code", () => {
		const result = interpretXattrRemoval(2, "");
		expect(R.isErr(result)).toBe(true);
		if (R.isErr(result)) {
			expect(result.error.message).toBe("xattr exited with code 2");
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

	test("remover throws synchronously → warning logged, no throw", () => {
		const warnings: string[] = [];
		const remover: QuarantineRemover = () => {
			throw new Error("boom from a buggy remover");
		};

		expect(() =>
			tryRemoveMacosQuarantine("/usr/local/bin/wt", {
				remover,
				warn: (m) => warnings.push(m),
			}),
		).not.toThrow();

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("boom from a buggy remover");
		expect(warnings[0]).toContain("/usr/local/bin/wt");
	});

	test("remover throws a non-Error → message still surfaces", () => {
		const warnings: string[] = [];
		const remover: QuarantineRemover = () => {
			throw "raw string failure";
		};

		expect(() =>
			tryRemoveMacosQuarantine("/usr/local/bin/wt", {
				remover,
				warn: (m) => warnings.push(m),
			}),
		).not.toThrow();

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("raw string failure");
	});
});
