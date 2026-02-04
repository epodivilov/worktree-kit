import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createTempDir } from "../../test-utils/temp-dir.ts";
import { createBunGitAdapter } from "./bun-git-adapter.ts";

async function initTestRepo(parentDir: string): Promise<string> {
	const repoPath = join(parentDir, "repo");
	await Bun.$`git init ${repoPath}`.quiet();
	await Bun.$`git -C ${repoPath} config user.name "Test"`.quiet();
	await Bun.$`git -C ${repoPath} config user.email "test@test.com"`.quiet();
	await Bun.write(join(repoPath, "README.md"), "test");
	await Bun.$`git -C ${repoPath} add .`.quiet();
	await Bun.$`git -C ${repoPath} commit -m "Initial commit"`.quiet();
	return repoPath;
}

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

	describe("listWorktrees", () => {
		test("returns single main worktree in fresh repo", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const worktrees = expectOk(await git.listWorktrees());
				expect(worktrees).toHaveLength(1);
				expect(worktrees[0]?.isMain).toBe(true);
				expect(worktrees[0]?.branch).toMatch(/^(main|master)$/);
				expect(worktrees[0]?.head).toMatch(/^[a-f0-9]{40}$/);
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("returns main and secondary worktrees", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			const wtPath = join(tmp.path, "feature-wt");
			await Bun.$`git -C ${repoPath} branch feature`.quiet();
			await Bun.$`git -C ${repoPath} worktree add ${wtPath} feature`.quiet();

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const worktrees = expectOk(await git.listWorktrees());
				expect(worktrees).toHaveLength(2);
				expect(worktrees[0]?.isMain).toBe(true);
				expect(worktrees[1]?.isMain).toBe(false);
				expect(worktrees[1]?.branch).toBe("feature");
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("handles detached HEAD worktree", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			const wtPath = join(tmp.path, "detached-wt");
			await Bun.$`git -C ${repoPath} worktree add --detach ${wtPath}`.quiet();

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const worktrees = expectOk(await git.listWorktrees());
				expect(worktrees).toHaveLength(2);
				const detached = worktrees.find((w) => !w.isMain && w.branch === "");
				expect(detached).toBeDefined();
				expect(detached?.head).toMatch(/^[a-f0-9]{40}$/);
			} finally {
				process.chdir(originalCwd);
			}
		});
	});

	describe("branchExists", () => {
		test("returns true for existing branch", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			await Bun.$`git -C ${repoPath} branch feature`.quiet();

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const exists = expectOk(await git.branchExists("feature"));
				expect(exists).toBe(true);
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("returns false for non-existing branch", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const exists = expectOk(await git.branchExists("nonexistent"));
				expect(exists).toBe(false);
			} finally {
				process.chdir(originalCwd);
			}
		});
	});

	describe("createWorktree", () => {
		test("creates worktree with new branch", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const wtPath = join(tmp.path, "feature-wt");
				const worktree = expectOk(await git.createWorktree("feature", wtPath));
				expect(worktree.path).toBe(wtPath);
				expect(worktree.branch).toBe("feature");
				expect(worktree.isMain).toBe(false);
				expect(worktree.head).toMatch(/^[a-f0-9]{40}$/);
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("creates worktree for existing branch", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			await Bun.$`git -C ${repoPath} branch feature`.quiet();

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const wtPath = join(tmp.path, "feature-wt");
				const worktree = expectOk(await git.createWorktree("feature", wtPath));
				expect(worktree.path).toBe(wtPath);
				expect(worktree.branch).toBe("feature");
				expect(worktree.isMain).toBe(false);
				expect(worktree.head).toMatch(/^[a-f0-9]{40}$/);
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("fails when branch is already checked out", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const defaultBranch = (await Bun.$`git -C ${repoPath} branch --show-current`.quiet().text()).trim();
				const wtPath = join(tmp.path, "duplicate-wt");
				const error = expectErr(await git.createWorktree(defaultBranch, wtPath));
				expect(error.code).toBe("BRANCH_EXISTS");
			} finally {
				process.chdir(originalCwd);
			}
		});
	});

	describe("removeWorktree", () => {
		test("removes existing worktree", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			const wtPath = join(tmp.path, "feature-wt");
			await Bun.$`git -C ${repoPath} branch feature`.quiet();
			await Bun.$`git -C ${repoPath} worktree add ${wtPath} feature`.quiet();

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				expectOk(await git.removeWorktree(wtPath));
				const worktrees = expectOk(await git.listWorktrees());
				expect(worktrees).toHaveLength(1);
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("fails when worktree does not exist", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const error = expectErr(await git.removeWorktree("/nonexistent/path"));
				expect(error.code).toBe("UNKNOWN");
			} finally {
				process.chdir(originalCwd);
			}
		});
	});
});
