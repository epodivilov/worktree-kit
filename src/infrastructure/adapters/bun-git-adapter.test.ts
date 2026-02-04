import { describe, expect, test } from "bun:test";
import { expectOk } from "../../test-utils/assertions.ts";
import { createBunGitAdapter } from "./bun-git-adapter.ts";

describe("BunGitAdapter", () => {
	const git = createBunGitAdapter();

	test("isGitRepository returns true when run inside a git repo", async () => {
		const isRepo = expectOk(await git.isGitRepository());
		expect(isRepo).toBe(true);
	});

	test("getRepositoryRoot returns a path containing the repo name", async () => {
		const root = expectOk(await git.getRepositoryRoot());
		expect(root).toContain("worktree-kit");
	});
});
