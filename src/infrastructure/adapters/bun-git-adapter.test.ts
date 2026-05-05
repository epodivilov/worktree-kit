import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createNoopLogger } from "../../test-utils/noop-logger.ts";
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
	const git = createBunGitAdapter(createNoopLogger());

	test("isGitRepository returns true when run inside a git repo", async () => {
		const isRepo = expectOk(await git.isGitRepository());
		expect(isRepo).toBe(true);
	});

	test("getRepositoryRoot returns a path containing the repo name", async () => {
		const root = expectOk(await git.getRepositoryRoot());
		expect(root).toContain("worktree-kit");
	});

	describe("getMainWorktreeRoot", () => {
		test("returns same as getRepositoryRoot in main worktree", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const repoRoot = expectOk(await git.getRepositoryRoot());
				const mainRoot = expectOk(await git.getMainWorktreeRoot());
				expect(mainRoot).toBe(repoRoot);
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("returns main worktree path when in linked worktree", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			const wtPath = join(tmp.path, "feature-wt");
			await Bun.$`git -C ${repoPath} branch feature`.quiet();
			await Bun.$`git -C ${repoPath} worktree add ${wtPath} feature`.quiet();

			const originalCwd = process.cwd();
			process.chdir(wtPath);
			try {
				const repoRoot = expectOk(await git.getRepositoryRoot());
				const mainRoot = expectOk(await git.getMainWorktreeRoot());
				// Use toContain to handle /var vs /private/var symlink on macOS
				expect(repoRoot).toContain("feature-wt");
				expect(mainRoot).toContain("repo");
				expect(mainRoot).not.toContain("feature-wt");
			} finally {
				process.chdir(originalCwd);
			}
		});
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
				expect(detached?.isPrunable).toBe(false);
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("flags worktree whose directory was deleted as prunable", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			const wtPath = join(tmp.path, "orphan-wt");
			await Bun.$`git -C ${repoPath} worktree add ${wtPath} -b orphan`.quiet();
			await Bun.$`rm -rf ${wtPath}`.quiet();

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const worktrees = expectOk(await git.listWorktrees());
				const orphan = worktrees.find((w) => w.branch === "orphan");
				expect(orphan).toBeDefined();
				expect(orphan?.isPrunable).toBe(true);
				expect(orphan?.prunableReason).toBeDefined();
			} finally {
				process.chdir(originalCwd);
			}
		});
	});

	describe("pruneWorktree", () => {
		test("removes admin record of the targeted prunable worktree", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			const wtPath = join(tmp.path, "to-prune");
			await Bun.$`git -C ${repoPath} worktree add ${wtPath} -b prunable-branch`.quiet();
			await Bun.$`rm -rf ${wtPath}`.quiet();

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				expectOk(await git.pruneWorktree(wtPath));
				const worktrees = expectOk(await git.listWorktrees());
				expect(worktrees.find((w) => w.branch === "prunable-branch")).toBeUndefined();
				expect(worktrees).toHaveLength(1);
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("does not affect other prunable worktrees", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			const wtPathA = join(tmp.path, "orphan-a");
			const wtPathB = join(tmp.path, "orphan-b");
			await Bun.$`git -C ${repoPath} worktree add ${wtPathA} -b orphan-a`.quiet();
			await Bun.$`git -C ${repoPath} worktree add ${wtPathB} -b orphan-b`.quiet();
			await Bun.$`rm -rf ${wtPathA}`.quiet();
			await Bun.$`rm -rf ${wtPathB}`.quiet();

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				expectOk(await git.pruneWorktree(wtPathA));
				const worktrees = expectOk(await git.listWorktrees());
				expect(worktrees.find((w) => w.branch === "orphan-a")).toBeUndefined();
				const orphanB = worktrees.find((w) => w.branch === "orphan-b");
				expect(orphanB).toBeDefined();
				expect(orphanB?.isPrunable).toBe(true);
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("works when invoked from inside a linked worktree", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			const linkedPath = join(tmp.path, "linked");
			const orphanPath = join(tmp.path, "orphan");
			await Bun.$`git -C ${repoPath} worktree add ${linkedPath} -b linked`.quiet();
			await Bun.$`git -C ${repoPath} worktree add ${orphanPath} -b orphan`.quiet();
			await Bun.$`rm -rf ${orphanPath}`.quiet();

			const originalCwd = process.cwd();
			process.chdir(linkedPath);
			try {
				expectOk(await git.pruneWorktree(orphanPath));
				const worktrees = expectOk(await git.listWorktrees());
				expect(worktrees.find((w) => w.branch === "orphan")).toBeUndefined();
				expect(worktrees.find((w) => w.branch === "linked")).toBeDefined();
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("returns error for unknown path", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const error = expectErr(await git.pruneWorktree("/nonexistent/orphan"));
				expect(error.code).toBe("UNKNOWN");
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("refuses to prune when working tree directory still exists", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			const wtPath = join(tmp.path, "healthy");
			await Bun.$`git -C ${repoPath} worktree add ${wtPath} -b healthy`.quiet();

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const error = expectErr(await git.pruneWorktree(wtPath));
				expect(error.code).toBe("UNKNOWN");
				expect(error.message).toContain("still exists");
				const worktrees = expectOk(await git.listWorktrees());
				expect(worktrees.find((w) => w.branch === "healthy")).toBeDefined();
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

	describe("revList / logSubjects / diffTreeFiles / diffNormalized / rebase --onto", () => {
		test("revList returns empty array for an empty range", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const head = (await Bun.$`git -C ${repoPath} rev-parse HEAD`.quiet().text()).trim();
				const commits = expectOk(await git.revList({ range: `${head}..${head}` }));
				expect(commits).toEqual([]);
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("revList returns commits in reverse-chronological order", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			const defaultBranch = (await Bun.$`git -C ${repoPath} symbolic-ref --short HEAD`.quiet().text()).trim();
			await Bun.$`git -C ${repoPath} checkout -b feature`.quiet();
			await Bun.write(join(repoPath, "a.txt"), "a");
			await Bun.$`git -C ${repoPath} add .`.quiet();
			await Bun.$`git -C ${repoPath} commit -m "feat: a"`.quiet();
			await Bun.write(join(repoPath, "b.txt"), "b");
			await Bun.$`git -C ${repoPath} add .`.quiet();
			await Bun.$`git -C ${repoPath} commit -m "feat: b"`.quiet();

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const commits = expectOk(await git.revList({ range: `${defaultBranch}..feature` }));
				expect(commits).toHaveLength(2);
				const subjects = await Promise.all(
					commits.map(async (sha) => (await Bun.$`git -C ${repoPath} log -1 --format=%s ${sha}`.quiet().text()).trim()),
				);
				expect(subjects[0]).toBe("feat: b");
				expect(subjects[1]).toBe("feat: a");
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("logSubjects parses %H %s lines and respects limit", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			await Bun.$`git -C ${repoPath} checkout -b feature`.quiet();
			await Bun.write(join(repoPath, "a.txt"), "a");
			await Bun.$`git -C ${repoPath} add .`.quiet();
			await Bun.$`git -C ${repoPath} commit -m "feat: a"`.quiet();
			await Bun.write(join(repoPath, "b.txt"), "b");
			await Bun.$`git -C ${repoPath} add .`.quiet();
			await Bun.$`git -C ${repoPath} commit -m "feat: b"`.quiet();

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const all = expectOk(await git.logSubjects("feature"));
				expect(all.length).toBeGreaterThanOrEqual(2);
				expect(all[0]?.subject).toBe("feat: b");
				expect(all[0]?.sha).toMatch(/^[a-f0-9]{40}$/);

				const limited = expectOk(await git.logSubjects("feature", 1));
				expect(limited).toHaveLength(1);
				expect(limited[0]?.subject).toBe("feat: b");
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("diffTreeFiles lists files changed by a commit", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			await Bun.write(join(repoPath, "x.txt"), "x");
			await Bun.write(join(repoPath, "y.txt"), "y");
			await Bun.$`git -C ${repoPath} add .`.quiet();
			await Bun.$`git -C ${repoPath} commit -m "two files"`.quiet();
			const head = (await Bun.$`git -C ${repoPath} rev-parse HEAD`.quiet().text()).trim();

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const files = expectOk(await git.diffTreeFiles(head));
				expect(new Set(files)).toEqual(new Set(["x.txt", "y.txt"]));
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("diffNormalized strips index and @@ lines", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			await Bun.write(join(repoPath, "a.txt"), "hello\n");
			await Bun.$`git -C ${repoPath} add .`.quiet();
			await Bun.$`git -C ${repoPath} commit -m "add a"`.quiet();
			const before = (await Bun.$`git -C ${repoPath} rev-parse HEAD`.quiet().text()).trim();
			await Bun.write(join(repoPath, "a.txt"), "hello world\n");
			await Bun.$`git -C ${repoPath} add .`.quiet();
			await Bun.$`git -C ${repoPath} commit -m "modify a"`.quiet();
			const after = (await Bun.$`git -C ${repoPath} rev-parse HEAD`.quiet().text()).trim();

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const diff = expectOk(await git.diffNormalized({ from: before, to: after }));
				expect(diff).not.toContain("\nindex ");
				expect(diff).not.toContain("\n@@");
				expect(diff).toContain("-hello");
				expect(diff).toContain("+hello world");
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("rebase with --onto invokes git rebase --onto <onto> <upstream> <branch>", async () => {
			// Build: main A — B; feature branches off A; feature commit C
			// Then squash-merge feature into main as commit S; remove feature.
			// Re-create feature branch with same commits B (already in main as S) + new commit D.
			// Run rebase with --onto main <commit-of-B-on-feature> feature → only D should land.
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			const defaultBranch = (await Bun.$`git -C ${repoPath} symbolic-ref --short HEAD`.quiet().text()).trim();

			await Bun.$`git -C ${repoPath} checkout -b feature`.quiet();
			await Bun.write(join(repoPath, "f1.txt"), "1");
			await Bun.$`git -C ${repoPath} add .`.quiet();
			await Bun.$`git -C ${repoPath} commit -m "f1"`.quiet();
			const f1 = (await Bun.$`git -C ${repoPath} rev-parse HEAD`.quiet().text()).trim();
			await Bun.write(join(repoPath, "f2.txt"), "2");
			await Bun.$`git -C ${repoPath} add .`.quiet();
			await Bun.$`git -C ${repoPath} commit -m "f2"`.quiet();

			await Bun.$`git -C ${repoPath} checkout ${defaultBranch}`.quiet();

			const result = await git.rebase(repoPath, defaultBranch, { upstream: f1, branch: "feature" });
			expectOk(result);

			// After rebase, feature should be checked out, with only "f2" replayed onto default
			const branch = (await Bun.$`git -C ${repoPath} symbolic-ref --short HEAD`.quiet().text()).trim();
			expect(branch).toBe("feature");
			const log = (await Bun.$`git -C ${repoPath} log --format=%s ${defaultBranch}..feature`.quiet().text()).trim();
			expect(log).toBe("f2");
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
