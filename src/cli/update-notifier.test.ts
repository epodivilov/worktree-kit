import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Container } from "../infrastructure/container.ts";
import { Result } from "../shared/result.ts";
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
			removeSymlink: bomb,
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

	for (const flag of ["--version", "-v"]) {
		test(`${flag} prints a cached newer-version notice on exit`, async () => {
			process.argv = ["bun", "wt", flag];
			const container = makeBombContainer();
			container.fs.readFile = async () => Result.ok(JSON.stringify({ checkedAt: Date.now(), latestVersion: "2.0.0" }));
			const exitListeners = new Set(process.listeners("exit"));
			const output = spyOn(console, "log").mockImplementation(() => {});

			try {
				await runUpdateNotifier(container, "1.0.0");
				const notice = process.listeners("exit").find((listener) => !exitListeners.has(listener));
				expect(notice).toBeDefined();
				notice?.(0);
				expect(
					output.mock.calls.some(([message]) =>
						["1.0.0", "2.0.0", "wt self-update"].every((part) => String(message).includes(part)),
					),
				).toBe(true);
			} finally {
				for (const listener of process.listeners("exit")) {
					if (!exitListeners.has(listener)) process.removeListener("exit", listener);
				}
				output.mockRestore();
			}
		});
	}

	test("version invocation never starts a refresh for stale cached data", async () => {
		process.argv = ["bun", "wt", "--version"];
		const container = makeBombContainer();
		container.fs.readFile = async () => Result.ok(JSON.stringify({ checkedAt: 0, latestVersion: "1.0.0" }));
		const spawn = spyOn(Bun, "spawn");
		const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
		try {
			await runUpdateNotifier(container, "1.0.0");
			expect(spawn).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			spawn.mockRestore();
			fetch.mockRestore();
		}
	});

	test("ordinary invocation starts a detached refresh for missing cache", async () => {
		const container = makeBombContainer();
		container.fs.readFile = async () => Result.err({ code: "NOT_FOUND", message: "missing", path: "cache" });
		const unref = mock(() => {});
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({ unref }) as never);
		const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
		try {
			await runUpdateNotifier(container, "1.0.0");
			expect(spawn).toHaveBeenCalledTimes(1);
			expect(unref).toHaveBeenCalledTimes(1);
			expect(spawn.mock.calls[0]?.[1]).toMatchObject({
				detached: true,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
		} finally {
			spawn.mockRestore();
			fetch.mockRestore();
		}
	});

	test("refresh spawn failure does not change ordinary command behavior", async () => {
		const container = makeBombContainer();
		container.fs.readFile = async () => Result.err({ code: "NOT_FOUND", message: "missing", path: "cache" });
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("spawn denied");
		});
		const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
		try {
			await expect(runUpdateNotifier(container, "1.0.0")).resolves.toBeUndefined();
		} finally {
			spawn.mockRestore();
			fetch.mockRestore();
		}
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

	test("skips when argv contains self-update command", async () => {
		process.argv = ["bun", "wt", "self-update"];
		await runUpdateNotifier(makeBombContainer(), "1.0.0");
	});

	test("calls checkForUpdates on normal TTY invocation", async () => {
		let readFileCalled = false;

		const container = makeBombContainer();
		container.fs.readFile = async () => {
			readFileCalled = true;
			const fresh = JSON.stringify({ checkedAt: Date.now(), latestVersion: "1.0.0" });
			return { success: true as const, data: fresh };
		};

		await runUpdateNotifier(container, "1.0.0");
		expect(readFileCalled).toBe(true);
	});
});
