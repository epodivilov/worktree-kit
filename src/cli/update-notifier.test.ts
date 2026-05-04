import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Container } from "../infrastructure/container.ts";
import { runUpdateNotifier } from "./update-notifier.ts";

function makeBombContainer(): Container {
	const bomb = () => {
		throw new Error("should not be called");
	};
	return {
		fs: {
			readFile: bomb,
			writeFile: bomb,
			exists: bomb,
			isDirectory: bomb,
			isSymlink: bomb,
			isSymlinkBroken: bomb,
			copyFile: bomb,
			copyDirectory: bomb,
			createSymlink: bomb,
			glob: bomb,
			listDirectory: bomb,
			getCwd: bomb,
			isDirectoryEmpty: bomb,
			removeDirectory: bomb,
			rename: bomb,
		},
		git: {} as Container["git"],
		ui: {} as Container["ui"],
		shell: {} as Container["shell"],
		logger: {} as Container["logger"],
	};
}

describe("runUpdateNotifier", () => {
	const originalIsTTY = process.stdout.isTTY;
	const originalArgv = process.argv;

	beforeEach(() => {
		process.stdout.isTTY = true;
		process.argv = ["bun", "wt", "list"];
	});

	afterEach(() => {
		process.stdout.isTTY = originalIsTTY;
		process.argv = originalArgv;
	});

	test("skips when stdout is not a TTY", async () => {
		process.stdout.isTTY = undefined as unknown as boolean;
		await runUpdateNotifier(makeBombContainer(), "1.0.0");
	});

	test("skips when argv contains --help", async () => {
		process.argv = ["bun", "wt", "--help"];
		await runUpdateNotifier(makeBombContainer(), "1.0.0");
	});

	test("skips when argv contains -h", async () => {
		process.argv = ["bun", "wt", "-h"];
		await runUpdateNotifier(makeBombContainer(), "1.0.0");
	});

	test("skips when argv contains --version", async () => {
		process.argv = ["bun", "wt", "--version"];
		await runUpdateNotifier(makeBombContainer(), "1.0.0");
	});

	test("skips when argv contains -v", async () => {
		process.argv = ["bun", "wt", "-v"];
		await runUpdateNotifier(makeBombContainer(), "1.0.0");
	});

	test("calls checkForUpdates on normal TTY invocation", async () => {
		let readFileCalled = false;

		const container = makeBombContainer();
		container.fs.readFile = async () => {
			readFileCalled = true;
			return { success: false as const, error: { code: "NOT_FOUND" as const, message: "", path: "" } };
		};

		await runUpdateNotifier(container, "1.0.0");
		expect(readFileCalled).toBe(true);
	});
});
