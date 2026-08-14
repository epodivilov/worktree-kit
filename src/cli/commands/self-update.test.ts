import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result as R } from "../../shared/result.ts";
import {
	detectBinaryName,
	downloadBinary,
	interpretXattrRemoval,
	MAX_DOWNLOAD_ATTEMPTS,
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

describe("downloadBinary retry", () => {
	// A connection-level Bun-fetch failure (WTK-59): thrown, not an HTTP status.
	const SOCKET_ERROR = "The socket connection was closed unexpectedly";

	function okResponse(bytes: Uint8Array): Response {
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			headers: new Headers({ "content-length": String(bytes.byteLength) }),
			body: (async function* () {
				yield bytes;
			})(),
		} as unknown as Response;
	}

	async function withTempTarget<T>(fn: (target: string) => Promise<T>): Promise<T> {
		const dir = await mkdtemp(join(tmpdir(), "wtk-self-update-"));
		try {
			return await fn(join(dir, "wt"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	const baseDeps = {
		platform: "linux" as NodeJS.Platform,
		quarantineRemover: (() => R.ok(undefined)) as QuarantineRemover,
		warn: () => {},
		// No-op backoff: retries/give-up must not run against real timers.
		sleep: async () => {},
	};

	test("R1/R2: retries after transient throws, then streams and writes the body", async () => {
		await withTempTarget(async (target) => {
			const payload = new TextEncoder().encode("new-binary-contents");
			const throwsFirst = 2;
			let calls = 0;
			const fetchImpl = (async () => {
				calls += 1;
				if (calls <= throwsFirst) throw new Error(SOCKET_ERROR);
				return okResponse(payload);
			}) as unknown as typeof fetch;

			const result = await downloadBinary("v1.2.3", "wt-linux-x64", target, {
				...baseDeps,
				fetchImpl,
			});

			expect(R.isOk(result)).toBe(true);
			expect(calls).toBe(throwsFirst + 1);
			expect(await Bun.file(target).text()).toBe("new-binary-contents");
		});
	});

	test("R3: gives up after exactly MAX_DOWNLOAD_ATTEMPTS when every attempt throws", async () => {
		await withTempTarget(async (target) => {
			let calls = 0;
			const fetchImpl = (async () => {
				calls += 1;
				throw new Error(SOCKET_ERROR);
			}) as unknown as typeof fetch;

			const result = await downloadBinary("v1.2.3", "wt-linux-x64", target, {
				...baseDeps,
				fetchImpl,
			});

			expect(R.isErr(result)).toBe(true);
			if (R.isErr(result)) {
				// Error is derived from the last attempt.
				expect(result.error.message).toContain(SOCKET_ERROR);
			}
			expect(calls).toBe(MAX_DOWNLOAD_ATTEMPTS);
		});
	});

	test("R4: does not retry a non-OK HTTP response (404 missing asset)", async () => {
		await withTempTarget(async (target) => {
			let calls = 0;
			const fetchImpl = (async () => {
				calls += 1;
				return {
					ok: false,
					status: 404,
					statusText: "Not Found",
					headers: new Headers(),
					body: null,
				} as unknown as Response;
			}) as unknown as typeof fetch;

			const result = await downloadBinary("v1.2.3", "wt-linux-x64", target, {
				...baseDeps,
				fetchImpl,
			});

			expect(R.isErr(result)).toBe(true);
			if (R.isErr(result)) {
				expect(result.error.message).toContain("404");
			}
			expect(calls).toBe(1);
		});
	});
});
