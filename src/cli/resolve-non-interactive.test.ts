import { describe, expect, test } from "bun:test";
import { resolveNonInteractive } from "./resolve-non-interactive.ts";

describe("resolveNonInteractive", () => {
	test("flag true forces non-interactive even with both TTYs", () => {
		expect(resolveNonInteractive({ flag: true, env: undefined, stdinIsTTY: true, stdoutIsTTY: true })).toBe(true);
	});

	test('env "1" forces non-interactive even with both TTYs', () => {
		expect(resolveNonInteractive({ flag: false, env: "1", stdinIsTTY: true, stdoutIsTTY: true })).toBe(true);
	});

	test("stdin not a TTY (false) implies non-interactive", () => {
		expect(resolveNonInteractive({ flag: false, env: undefined, stdinIsTTY: false, stdoutIsTTY: true })).toBe(true);
	});

	test("stdin not a TTY (undefined) implies non-interactive", () => {
		expect(resolveNonInteractive({ flag: false, env: undefined, stdinIsTTY: undefined, stdoutIsTTY: true })).toBe(true);
	});

	test("stdout not a TTY (false) implies non-interactive", () => {
		expect(resolveNonInteractive({ flag: false, env: undefined, stdinIsTTY: true, stdoutIsTTY: false })).toBe(true);
	});

	test("stdout not a TTY (undefined) implies non-interactive", () => {
		expect(resolveNonInteractive({ flag: false, env: undefined, stdinIsTTY: true, stdoutIsTTY: undefined })).toBe(true);
	});

	test('env other than "1" does not force non-interactive', () => {
		expect(resolveNonInteractive({ flag: false, env: "0", stdinIsTTY: true, stdoutIsTTY: true })).toBe(false);
	});

	test('interactive only when flag is false, env is not "1", and both stdin and stdout are TTYs', () => {
		expect(resolveNonInteractive({ flag: false, env: undefined, stdinIsTTY: true, stdoutIsTTY: true })).toBe(false);
	});
});
