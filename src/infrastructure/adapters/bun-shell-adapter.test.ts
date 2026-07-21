import { describe, expect, test } from "bun:test";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createNoopLogger } from "../../test-utils/noop-logger.ts";
import { createTempDir } from "../../test-utils/temp-dir.ts";
import { createBunShellAdapter } from "./bun-shell-adapter.ts";

describe("BunShellAdapter", () => {
	test("runs the command through the resolved shell", async () => {
		await using tmp = await createTempDir();
		const shell = createBunShellAdapter(createNoopLogger());

		const result = expectOk(await shell.execute("echo hello", { cwd: tmp.path }));

		expect(result.stdout).toBe("hello");
		expect(result.exitCode).toBe(0);
	});

	test("passes env variables to the command", async () => {
		await using tmp = await createTempDir();
		const shell = createBunShellAdapter(createNoopLogger());

		const result = expectOk(
			await shell.execute("echo $WORKTREE_BRANCH", { cwd: tmp.path, env: { WORKTREE_BRANCH: "feature" } }),
		);

		expect(result.stdout).toBe("feature");
	});

	test("returns EXECUTION_FAILED for a non-zero exit code", async () => {
		await using tmp = await createTempDir();
		const shell = createBunShellAdapter(createNoopLogger());

		const error = expectErr(await shell.execute("exit 3", { cwd: tmp.path }));

		expect(error.code).toBe("EXECUTION_FAILED");
		expect(error.exitCode).toBe(3);
	});

	test("returns SHELL_UNAVAILABLE when sh is not on PATH", async () => {
		const shell = createBunShellAdapter(createNoopLogger(), () => null);

		const error = expectErr(await shell.execute("echo hello", { cwd: process.cwd() }));

		expect(error.code).toBe("SHELL_UNAVAILABLE");
		expect(error.message).toContain("sh -c");
	});

	test("resolves the shell once and reuses the lookup", async () => {
		const lookups: string[] = [];
		const shell = createBunShellAdapter(createNoopLogger(), (cmd) => {
			lookups.push(cmd);
			return null;
		});

		await shell.execute("echo one", { cwd: process.cwd() });
		await shell.execute("echo two", { cwd: process.cwd() });

		expect(lookups).toEqual(["sh"]);
	});
});
