import { describe, expect, test } from "bun:test";
import { Result } from "../../shared/result.ts";
import { createFakeShell } from "../../test-utils/fake-shell.ts";
import { runHooks } from "./run-hooks.ts";

describe("runHooks", () => {
	const defaultContext = {
		worktreePath: "/worktrees/feature",
		branch: "feature",
		repoRoot: "/repo",
	};

	test("executes all commands successfully", async () => {
		const shell = createFakeShell();
		const result = await runHooks(
			{
				commands: ["pnpm install", "cp .env.example .env"],
				context: defaultContext,
			},
			{ shell },
		);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.failedCommands).toHaveLength(0);
			expect(result.data.notifications).toHaveLength(2);
			expect(result.data.notifications[0]?.level).toBe("info");
			expect(result.data.notifications[1]?.level).toBe("info");
		}
		expect(shell.calls).toHaveLength(2);
	});

	test("continues after failed command", async () => {
		const results = new Map();
		results.set("failing-command", Result.err({ code: "EXECUTION_FAILED", message: "Failed" }));

		const shell = createFakeShell({ results });
		const result = await runHooks(
			{
				commands: ["failing-command", "pnpm install"],
				context: defaultContext,
			},
			{ shell },
		);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.failedCommands).toEqual(["failing-command"]);
			expect(result.data.notifications).toHaveLength(2);
			expect(result.data.notifications[0]?.level).toBe("warn");
			expect(result.data.notifications[1]?.level).toBe("info");
		}
	});

	test("passes correct env variables", async () => {
		const shell = createFakeShell();
		await runHooks(
			{
				commands: ["echo test"],
				context: {
					worktreePath: "/worktrees/feature",
					branch: "feature-branch",
					repoRoot: "/repo",
					baseBranch: "main",
				},
			},
			{ shell },
		);

		expect(shell.calls[0]?.options.env).toEqual({
			WORKTREE_PATH: "/worktrees/feature",
			WORKTREE_BRANCH: "feature-branch",
			REPO_ROOT: "/repo",
			BASE_BRANCH: "main",
		});
	});

	test("omits BASE_BRANCH when not provided", async () => {
		const shell = createFakeShell();
		await runHooks(
			{
				commands: ["echo test"],
				context: defaultContext,
			},
			{ shell },
		);

		expect(shell.calls[0]?.options.env).toEqual({
			WORKTREE_PATH: "/worktrees/feature",
			WORKTREE_BRANCH: "feature",
			REPO_ROOT: "/repo",
		});
	});

	test("sets cwd to worktreePath", async () => {
		const shell = createFakeShell();
		await runHooks(
			{
				commands: ["pnpm install"],
				context: defaultContext,
			},
			{ shell },
		);

		expect(shell.calls[0]?.options.cwd).toBe("/worktrees/feature");
	});

	test("warns once and skips remaining commands when no shell is available", async () => {
		const shell = createFakeShell({
			defaultResult: Result.err({ code: "SHELL_UNAVAILABLE", message: "no POSIX shell on PATH" }),
		});

		const result = await runHooks(
			{
				commands: ["pnpm install", "cp .env.example .env", "echo done"],
				context: defaultContext,
			},
			{ shell },
		);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.notifications).toHaveLength(1);
			expect(result.data.notifications[0]?.level).toBe("warn");
			expect(result.data.notifications[0]?.message).toBe("Skipped 3 hook(s): no POSIX shell on PATH");
			expect(result.data.failedCommands).toEqual(["pnpm install", "cp .env.example .env", "echo done"]);
		}
		// Stops after the first attempt — no shell means no command can run.
		expect(shell.calls).toHaveLength(1);
	});

	test("reports only the unrun commands when the shell disappears mid-run", async () => {
		const results = new Map();
		results.set("second", Result.err({ code: "SHELL_UNAVAILABLE", message: "no POSIX shell on PATH" }));

		const shell = createFakeShell({ results });
		const result = await runHooks(
			{
				commands: ["first", "second", "third"],
				context: defaultContext,
			},
			{ shell },
		);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.failedCommands).toEqual(["second", "third"]);
			expect(result.data.notifications.map((n) => n.level)).toEqual(["info", "warn"]);
			expect(result.data.notifications[1]?.message).toBe("Skipped 2 hook(s): no POSIX shell on PATH");
		}
	});

	test("returns empty results for empty commands", async () => {
		const shell = createFakeShell();
		const result = await runHooks(
			{
				commands: [],
				context: defaultContext,
			},
			{ shell },
		);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.failedCommands).toHaveLength(0);
			expect(result.data.notifications).toHaveLength(0);
		}
		expect(shell.calls).toHaveLength(0);
	});
});
