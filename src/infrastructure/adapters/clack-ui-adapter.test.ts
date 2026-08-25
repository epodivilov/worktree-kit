import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { computeFrameHeight, createClackUiAdapter } from "./clack-ui-adapter.ts";

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

	test("skip() emits a plain-text line with a neutral marker", () => {
		const ui = createClackUiAdapter();
		const spinner = ui.createMultiSpinner(["install", "build"]);

		spinner.skip("build", "skipped (locked)");

		expect(captured).toHaveLength(1);
		expect(captured[0]).toBe("  ○  build: skipped (locked)\n");
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

describe("computeFrameHeight", () => {
	test("a line shorter than columns counts as 1 physical row", () => {
		expect(computeFrameHeight(["short line"], 20)).toBe(1);
	});

	test("a line whose display width is between columns and 2*columns counts as 2 physical rows", () => {
		const line = "x".repeat(25);
		expect(computeFrameHeight([line], 20)).toBe(2);
	});

	test("the total for several lines equals the sum of per-line physical rows", () => {
		const lines = ["a".repeat(5), "b".repeat(25), "c".repeat(45)];
		expect(computeFrameHeight(lines, 20)).toBe(1 + 2 + 3);
	});

	test("ANSI color escapes do not count toward a line's width", () => {
		const colored = "\x1b[32mhello\x1b[39m";
		// Sanity: the raw (unstripped) string is longer than the column width, so this
		// would wrap to 2 rows if escapes were counted toward width.
		expect(colored.length).toBeGreaterThan(10);
		expect(computeFrameHeight([colored], 10)).toBe(1);
	});

	test("defaults to 80 columns when columns is not provided", () => {
		const line = "x".repeat(90);
		expect(computeFrameHeight([line])).toBe(2);
		expect(computeFrameHeight([line], undefined)).toBe(2);
	});
});

describe("createMultiSpinner TTY", () => {
	const originalIsTTY = process.stdout.isTTY;
	const originalColumns = process.stdout.columns;
	const originalWrite = process.stdout.write;
	let captured: string[];

	beforeEach(() => {
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "columns", { value: 5, configurable: true });
		captured = [];
		process.stdout.write = mock((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(() => {
		Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
		Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true });
		process.stdout.write = originalWrite;
	});

	test("repaint rewinds by the previous frame's physical height and erases with a single erase-to-end-of-display", () => {
		const ui = createClackUiAdapter();
		const spinner = ui.createMultiSpinner(["short", "long-branch-name"]);

		// First render: hide cursor, then draw the frame body in one write.
		expect(captured[0]).toBe("\x1b[?25l");
		const frameBody = captured[1];
		if (frameBody === undefined) throw new Error("expected a frame body write after the cursor-hide write");
		const firstFrameLines = frameBody.replace(/\n$/, "").split("\n");
		expect(firstFrameLines).toHaveLength(2);

		const expectedHeight = computeFrameHeight(firstFrameLines, 5);
		// With columns=5 these lines must wrap, so the physical height exceeds the
		// logical line count - this is exactly the distinction the fix must rewind by.
		expect(expectedHeight).toBeGreaterThan(firstFrameLines.length);

		spinner.complete("short", "done");
		spinner.stop();

		// Repaint control sequence: rewind by the PREVIOUS frame's physical height,
		// move to column 1, erase to end of display - not a per-line \x1b[2K clear.
		expect(captured[2]).toBe(`\x1b[${expectedHeight}A\x1b[1G\x1b[J`);

		const allOutput = captured.join("");
		expect(allOutput).not.toContain("\x1b[2K");
	});

	test("hides the cursor on first render and shows it again on stop", () => {
		const ui = createClackUiAdapter();
		const spinner = ui.createMultiSpinner(["a"]);

		spinner.stop();

		expect(captured[0]).toBe("\x1b[?25l");
		expect(captured.at(-1)).toBe("\x1b[?25h");
	});
});
