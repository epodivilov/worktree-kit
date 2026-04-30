import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createClackUiAdapter } from "./clack-ui-adapter.ts";

describe("createMultiSpinner non-TTY", () => {
	const originalIsTTY = process.stdout.isTTY;
	let captured: string[];
	const originalWrite = process.stdout.write;

	beforeEach(() => {
		Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
		captured = [];
		process.stdout.write = mock((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(() => {
		Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
		process.stdout.write = originalWrite;
	});

	test("complete() emits a plain-text line with checkmark", () => {
		const ui = createClackUiAdapter();
		const spinner = ui.createMultiSpinner(["install", "build"]);

		spinner.complete("install", "done in 1.2s");

		expect(captured).toHaveLength(1);
		expect(captured[0]).toBe("  ✓  install: done in 1.2s\n");
	});

	test("fail() emits a plain-text line with cross mark", () => {
		const ui = createClackUiAdapter();
		const spinner = ui.createMultiSpinner(["install", "build"]);

		spinner.fail("build", "exit code 1");

		expect(captured).toHaveLength(1);
		expect(captured[0]).toBe("  ✗  build: exit code 1\n");
	});

	test("update() produces no output", () => {
		const ui = createClackUiAdapter();
		const spinner = ui.createMultiSpinner(["install"]);

		spinner.update("install", "downloading packages...");

		expect(captured).toHaveLength(0);
	});

	test("stop() produces no output", () => {
		const ui = createClackUiAdapter();
		const spinner = ui.createMultiSpinner(["install"]);

		spinner.stop();

		expect(captured).toHaveLength(0);
	});

	test("output contains no ANSI escape sequences", () => {
		const ui = createClackUiAdapter();
		const spinner = ui.createMultiSpinner(["a", "b", "c"]);

		spinner.update("a", "working...");
		spinner.complete("a", "ok");
		spinner.fail("b", "failed");
		spinner.complete("c", "ok");
		spinner.stop();

		const allOutput = captured.join("");
		expect(allOutput).not.toContain("\x1b");
	});
});
