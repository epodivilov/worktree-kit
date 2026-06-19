import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createRemoteFixture, initTestRepo, initUnbornRepo } from "../../test-utils/git-fixtures.ts";
import { createNoopLogger } from "../../test-utils/noop-logger.ts";
import { createTempDir } from "../../test-utils/temp-dir.ts";
import { createBunGitAdapter } from "./bun-git-adapter.ts";

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

	describe("addRemote / listRemotes", () => {
		test("listRemotes returns empty array for a fresh repo with no remotes", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const remotes = expectOk(await git.listRemotes());
				expect(remotes).toEqual([]);
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("addRemote adds a remote that listRemotes then reports", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				expectOk(await git.addRemote("upstream", "https://example.com/orig/repo.git"));
				const remotes = expectOk(await git.listRemotes());
				expect(remotes).toContain("upstream");
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("addRemote fails when the remote already exists", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			await Bun.$`git -C ${repoPath} remote add upstream https://example.com/orig/repo.git`.quiet();

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const error = expectErr(await git.addRemote("upstream", "https://example.com/other/repo.git"));
				expect(error.code).toBe("UNKNOWN");
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("getRemoteUrl returns the configured URL", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			await Bun.$`git -C ${repoPath} remote add upstream https://example.com/orig/repo.git`.quiet();

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const url = expectOk(await git.getRemoteUrl("upstream"));
				expect(url).toBe("https://example.com/orig/repo.git");
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("getRemoteUrl fails for an unknown remote", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const error = expectErr(await git.getRemoteUrl("nope"));
				expect(error.code).toBe("UNKNOWN");
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("setRemoteUrl updates the URL reported by getRemoteUrl", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			await Bun.$`git -C ${repoPath} remote add upstream https://example.com/orig/repo.git`.quiet();

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				expectOk(await git.setRemoteUrl("upstream", "https://example.com/new/repo.git"));
				const url = expectOk(await git.getRemoteUrl("upstream"));
				expect(url).toBe("https://example.com/new/repo.git");
			} finally {
				process.chdir(originalCwd);
			}
		});

		test("setRemoteUrl fails for an unknown remote", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const error = expectErr(await git.setRemoteUrl("nope", "https://example.com/x.git"));
				expect(error.code).toBe("UNKNOWN");
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

		test("returns WORKTREE_LOCKED with lock reason for a locked worktree", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			const wtPath = join(tmp.path, "feature-wt");
			await Bun.$`git -C ${repoPath} branch feature`.quiet();
			await Bun.$`git -C ${repoPath} worktree add ${wtPath} feature`.quiet();
			await Bun.$`git -C ${repoPath} worktree lock ${wtPath} --reason ${"claude agent (pid 4242)"}`.quiet();

			const originalCwd = process.cwd();
			process.chdir(repoPath);
			try {
				const error = expectErr(await git.removeWorktree(wtPath));
				expect(error.code).toBe("WORKTREE_LOCKED");
				expect(error.message).toBe("claude agent (pid 4242)");

				// Locked worktree must remain.
				const worktrees = expectOk(await git.listWorktrees());
				expect(worktrees).toHaveLength(2);
			} finally {
				process.chdir(originalCwd);
			}
		});
	});

	// === Local-repo coverage (cwd-based methods use withCwd) ===

	async function withCwd<T>(path: string, fn: () => Promise<T>): Promise<T> {
		const originalCwd = process.cwd();
		process.chdir(path);
		try {
			return await fn();
		} finally {
			process.chdir(originalCwd);
		}
	}

	/** Commit a file change on the given branch (checkout + commit + back to main). */
	async function commitOnBranch(repoPath: string, branch: string, file: string, content: string): Promise<void> {
		await Bun.$`git -C ${repoPath} checkout -q ${branch}`.quiet();
		await Bun.write(join(repoPath, file), content);
		await Bun.$`git -C ${repoPath} add .`.quiet();
		await Bun.$`git -C ${repoPath} commit -m ${`edit ${file} on ${branch}`}`.quiet();
		await Bun.$`git -C ${repoPath} checkout -q main`.quiet();
	}

	describe("WIP commit cycle", () => {
		test("stageAll → commitWip → getLastCommitMessage → resetLastCommit restores dirty state", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			await Bun.write(join(repoPath, "work.txt"), "in progress");

			expect(expectOk(await git.isDirty(repoPath))).toBe(true);
			expectOk(await git.stageAll(repoPath));
			expectOk(await git.commitWip(repoPath));
			expect(expectOk(await git.getLastCommitMessage(repoPath))).toBe("WIP");
			expect(expectOk(await git.isDirty(repoPath))).toBe(false);

			expectOk(await git.resetLastCommit(repoPath));
			expect(expectOk(await git.getLastCommitMessage(repoPath))).toBe("Initial commit");
			expect(expectOk(await git.isDirty(repoPath))).toBe(true);
		});
	});

	describe("isDirty", () => {
		test("clean repo is not dirty", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			expect(expectOk(await git.isDirty(repoPath))).toBe(false);
		});
	});

	describe("branch topology queries", () => {
		test("getCommitCount counts commits ahead of a base", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			await Bun.$`git -C ${repoPath} branch feature`.quiet();
			await commitOnBranch(repoPath, "feature", "a.txt", "a");
			await commitOnBranch(repoPath, "feature", "b.txt", "b");

			await withCwd(repoPath, async () => {
				expect(expectOk(await git.getCommitCount("main", "feature"))).toBe(2);
				expect(expectOk(await git.getCommitCount("feature", "main"))).toBe(0);
			});
		});

		test("getMergeBase returns the fork point", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			const forkSha = (await Bun.$`git -C ${repoPath} rev-parse HEAD`.quiet().text()).trim();
			await Bun.$`git -C ${repoPath} branch feature`.quiet();
			await commitOnBranch(repoPath, "feature", "a.txt", "a");
			await commitOnBranch(repoPath, "main", "m.txt", "m");

			await withCwd(repoPath, async () => {
				expect(expectOk(await git.getMergeBase("main", "feature"))).toBe(forkSha);
			});
		});

		test("revListCherryPick excludes patch-equivalent commits", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			await Bun.$`git -C ${repoPath} branch feature`.quiet();
			await commitOnBranch(repoPath, "feature", "picked.txt", "same content");
			const pickedSha = (await Bun.$`git -C ${repoPath} rev-parse feature`.quiet().text()).trim();
			await commitOnBranch(repoPath, "feature", "unique.txt", "only on feature");
			// Cherry-pick the first feature commit onto main.
			await Bun.$`git -C ${repoPath} cherry-pick ${pickedSha}`.quiet();

			await withCwd(repoPath, async () => {
				const remaining = expectOk(await git.revListCherryPick({ base: "main", feature: "feature" }));
				expect(remaining).toHaveLength(1);
				expect(remaining[0]).not.toBe(pickedSha);
			});
		});

		test("listBranches returns all local branches", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			await Bun.$`git -C ${repoPath} branch feature-a`.quiet();
			await Bun.$`git -C ${repoPath} branch feature-b`.quiet();

			await withCwd(repoPath, async () => {
				const branches = expectOk(await git.listBranches());
				expect(branches.sort()).toEqual(["feature-a", "feature-b", "main"]);
			});
		});
	});

	describe("deleteBranch / deleteBranchForce", () => {
		test("merged branch is deleted", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			await Bun.$`git -C ${repoPath} branch merged`.quiet();

			await withCwd(repoPath, async () => {
				expectOk(await git.deleteBranch("merged"));
				expect(expectOk(await git.branchExists("merged"))).toBe(false);
			});
		});

		test("unmerged branch fails with BRANCH_NOT_MERGED, force delete succeeds", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			await Bun.$`git -C ${repoPath} branch feature`.quiet();
			await commitOnBranch(repoPath, "feature", "f.txt", "f");

			await withCwd(repoPath, async () => {
				const error = expectErr(await git.deleteBranch("feature"));
				expect(error.code).toBe("BRANCH_NOT_MERGED");

				expectOk(await git.deleteBranchForce("feature"));
				expect(expectOk(await git.branchExists("feature"))).toBe(false);
			});
		});

		test("nonexistent branch fails with BRANCH_NOT_FOUND", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);

			await withCwd(repoPath, async () => {
				expect(expectErr(await git.deleteBranch("ghost")).code).toBe("BRANCH_NOT_FOUND");
				expect(expectErr(await git.deleteBranchForce("ghost")).code).toBe("BRANCH_NOT_FOUND");
			});
		});
	});

	describe("rebase and merge state", () => {
		/** Repo where rebasing feature onto main conflicts on README.md. */
		async function initConflictRepo(parentDir: string): Promise<string> {
			const repoPath = await initTestRepo(parentDir);
			await Bun.$`git -C ${repoPath} branch feature`.quiet();
			await commitOnBranch(repoPath, "feature", "README.md", "feature version");
			await commitOnBranch(repoPath, "main", "README.md", "main version");
			return repoPath;
		}

		test("isRebaseInProgress true mid-conflict, rebaseAbort clears it", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initConflictRepo(tmp.path);
			await Bun.$`git -C ${repoPath} checkout -q feature`.quiet();

			const rebaseResult = await git.rebase(repoPath, "main");
			expectErr(rebaseResult);
			expect(expectOk(await git.isRebaseInProgress(repoPath))).toBe(true);

			expectOk(await git.rebaseAbort(repoPath));
			expect(expectOk(await git.isRebaseInProgress(repoPath))).toBe(false);
			expect(expectOk(await git.getLastCommitMessage(repoPath))).toBe("edit README.md on feature");
		});

		test("isMergeInProgress true mid-conflict, false after abort", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initConflictRepo(tmp.path);

			expect(expectOk(await git.isMergeInProgress(repoPath))).toBe(false);
			await Bun.$`git -C ${repoPath} merge feature`.quiet().nothrow();
			expect(expectOk(await git.isMergeInProgress(repoPath))).toBe(true);

			await Bun.$`git -C ${repoPath} merge --abort`.quiet();
			expect(expectOk(await git.isMergeInProgress(repoPath))).toBe(false);
		});
	});

	describe("moveWorktree", () => {
		test("worktree is reachable at the new path after move", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			const fromPath = join(tmp.path, "wt-old");
			const toPath = join(tmp.path, "wt-new");
			await Bun.$`git -C ${repoPath} branch feature`.quiet();
			await Bun.$`git -C ${repoPath} worktree add ${fromPath} feature`.quiet();

			await withCwd(repoPath, async () => {
				expectOk(await git.moveWorktree(fromPath, toPath));
				const worktrees = expectOk(await git.listWorktrees());
				const feature = worktrees.find((w) => w.branch === "feature");
				expect(feature?.path).toContain("wt-new");
			});
			expect(expectOk(await git.isDirty(toPath))).toBe(false);
		});
	});

	describe("isPathTracked", () => {
		test("tracked file true, untracked file false", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			await Bun.write(join(repoPath, "untracked.txt"), "x");

			expect(expectOk(await git.isPathTracked(repoPath, "README.md"))).toBe(true);
			expect(expectOk(await git.isPathTracked(repoPath, "untracked.txt"))).toBe(false);
		});
	});

	// === Remote-fixture coverage ===

	/** Commit + push on the given clone (on its current branch). */
	async function pushCommit(clonePath: string, file: string, content: string): Promise<string> {
		await Bun.write(join(clonePath, file), content);
		await Bun.$`git -C ${clonePath} add .`.quiet();
		await Bun.$`git -C ${clonePath} commit -m ${`edit ${file}`}`.quiet();
		await Bun.$`git -C ${clonePath} push`.quiet();
		return (await Bun.$`git -C ${clonePath} rev-parse HEAD`.quiet().text()).trim();
	}

	describe("remote branch operations", () => {
		test("listRemoteBranches returns names stripped of the origin/ prefix", async () => {
			await using tmp = await createTempDir();
			const fixture = await createRemoteFixture(tmp.path);
			await fixture.addTrackedBranch("feat-a");
			await fixture.addTrackedBranch("feat-b", { withCommit: true });

			await withCwd(fixture.repoPath, async () => {
				const branches = expectOk(await git.listRemoteBranches());
				expect(branches.sort()).toEqual(["feat-a", "feat-b", "main"]);
			});
		});

		test("deleteRemoteBranch removes the ref on the remote", async () => {
			await using tmp = await createTempDir();
			const fixture = await createRemoteFixture(tmp.path);
			await fixture.addTrackedBranch("doomed");

			await withCwd(fixture.repoPath, async () => {
				expectOk(await git.deleteRemoteBranch("doomed"));
				const remoteRefs = await Bun.$`git -C ${fixture.remotePath} branch --list doomed`.quiet().text();
				expect(remoteRefs.trim()).toBe("");
			});
		});

		test("deleteRemoteBranch on a missing ref fails with REMOTE_REF_NOT_FOUND", async () => {
			await using tmp = await createTempDir();
			const fixture = await createRemoteFixture(tmp.path);

			await withCwd(fixture.repoPath, async () => {
				const error = expectErr(await git.deleteRemoteBranch("never-existed"));
				expect(error.code).toBe("REMOTE_REF_NOT_FOUND");
			});
		});

		test("fetchAll picks up commits pushed from elsewhere", async () => {
			await using tmp = await createTempDir();
			const fixture = await createRemoteFixture(tmp.path);
			const clonePath = await fixture.cloneSecond();
			const pushedSha = await pushCommit(clonePath, "elsewhere.txt", "pushed from clone2");

			await withCwd(fixture.repoPath, async () => {
				expectOk(await git.fetchAll());
				const originMain = (await Bun.$`git -C ${fixture.repoPath} rev-parse origin/main`.quiet().text()).trim();
				expect(originMain).toBe(pushedSha);
			});
		});

		test("getDefaultBranch resolves main for a cloned repo", async () => {
			await using tmp = await createTempDir();
			const fixture = await createRemoteFixture(tmp.path);

			await withCwd(fixture.repoPath, async () => {
				expect(expectOk(await git.getDefaultBranch())).toBe("main");
			});
		});

		test("updateBranchRef fast-forwards a non-checked-out branch ref", async () => {
			await using tmp = await createTempDir();
			const fixture = await createRemoteFixture(tmp.path);
			await fixture.addTrackedBranch("feat");
			const clonePath = await fixture.cloneSecond();
			await Bun.$`git -C ${clonePath} checkout -q feat`.quiet();
			const pushedSha = await pushCommit(clonePath, "feat.txt", "remote moved ahead");

			await withCwd(fixture.repoPath, async () => {
				// main stays checked out; feat is updated by ref only.
				expectOk(await git.updateBranchRef("feat"));
				const localSha = (await Bun.$`git -C ${fixture.repoPath} rev-parse feat`.quiet().text()).trim();
				expect(localSha).toBe(pushedSha);
			});
		});

		test("mergeFFOnly fast-forwards when behind, fails when diverged", async () => {
			await using tmp = await createTempDir();
			const fixture = await createRemoteFixture(tmp.path);
			const clonePath = await fixture.cloneSecond();
			const pushedSha = await pushCommit(clonePath, "ff.txt", "remote ahead");

			await Bun.$`git -C ${fixture.repoPath} fetch origin`.quiet();
			expectOk(await git.mergeFFOnly(fixture.repoPath, "main"));
			const localSha = (await Bun.$`git -C ${fixture.repoPath} rev-parse main`.quiet().text()).trim();
			expect(localSha).toBe(pushedSha);

			// Diverge: local commit + remote commit.
			await Bun.write(join(fixture.repoPath, "local.txt"), "local");
			await Bun.$`git -C ${fixture.repoPath} add .`.quiet();
			await Bun.$`git -C ${fixture.repoPath} commit -m "local diverges"`.quiet();
			await pushCommit(clonePath, "remote.txt", "remote diverges");
			await Bun.$`git -C ${fixture.repoPath} fetch origin`.quiet();

			const error = expectErr(await git.mergeFFOnly(fixture.repoPath, "main"));
			expect(error.code).toBe("MERGE_FAILED");
		});

		test("createWorktreeFromRemote checks out a remote-only branch with tracking", async () => {
			await using tmp = await createTempDir();
			const fixture = await createRemoteFixture(tmp.path);
			const clonePath = await fixture.cloneSecond();
			await Bun.$`git -C ${clonePath} checkout -q -b remote-only`.quiet();
			await Bun.$`git -C ${clonePath} push -u origin remote-only`.quiet();
			const wtPath = join(tmp.path, "wt-remote");

			await withCwd(fixture.repoPath, async () => {
				expectOk(await git.fetchAll());
				expect(expectOk(await git.branchExists("remote-only"))).toBe(false);

				const worktree = expectOk(await git.createWorktreeFromRemote("remote-only", wtPath, "origin"));
				expect(worktree.branch).toBe("remote-only");
				expect(expectOk(await git.branchExists("remote-only"))).toBe(true);

				const upstream = await Bun.$`git -C ${wtPath} rev-parse --abbrev-ref ${"remote-only@{upstream}"}`
					.quiet()
					.text();
				expect(upstream.trim()).toBe("origin/remote-only");
			});
		});
	});

	// === Non-origin remote resolution ===
	//
	// The adapter resolves the primary remote name lazily from git's own
	// configuration (tracking branch of HEAD / main / master, or a sole
	// remote), with "origin" only as the final fallback. These tests use
	// fresh adapter instances because the per-instance remote-name cache
	// would otherwise be locked by an earlier test running against "origin".

	describe("non-origin remote name", () => {
		test("listRemoteBranches strips the resolved remote prefix when remote is 'upstream'", async () => {
			await using tmp = await createTempDir();
			const fixture = await createRemoteFixture(tmp.path, { remoteName: "upstream" });
			await fixture.addTrackedBranch("feat-a");
			await fixture.addTrackedBranch("feat-b", { withCommit: true });

			await withCwd(fixture.repoPath, async () => {
				const localGit = createBunGitAdapter(createNoopLogger());
				const branches = expectOk(await localGit.listRemoteBranches());
				expect(branches.sort()).toEqual(["feat-a", "feat-b", "main"]);
			});
		});

		test("getDefaultBranch resolves HEAD via the non-origin remote", async () => {
			await using tmp = await createTempDir();
			const fixture = await createRemoteFixture(tmp.path, { remoteName: "upstream" });

			await withCwd(fixture.repoPath, async () => {
				const localGit = createBunGitAdapter(createNoopLogger());
				expect(expectOk(await localGit.getDefaultBranch())).toBe("main");
			});
		});

		test("mergeFFOnly without an explicit remote uses the resolved non-origin remote", async () => {
			await using tmp = await createTempDir();
			const fixture = await createRemoteFixture(tmp.path, { remoteName: "upstream" });
			const clonePath = await fixture.cloneSecond();
			const pushedSha = await pushCommit(clonePath, "ff.txt", "remote ahead");

			await Bun.$`git -C ${fixture.repoPath} fetch upstream`.quiet();
			await withCwd(fixture.repoPath, async () => {
				const localGit = createBunGitAdapter(createNoopLogger());
				expectOk(await localGit.mergeFFOnly(fixture.repoPath, "main"));
				const localSha = (await Bun.$`git -C ${fixture.repoPath} rev-parse main`.quiet().text()).trim();
				expect(localSha).toBe(pushedSha);
			});
		});

		test("updateBranchRef fetches from the resolved non-origin remote", async () => {
			await using tmp = await createTempDir();
			const fixture = await createRemoteFixture(tmp.path, { remoteName: "upstream" });
			await fixture.addTrackedBranch("feat");
			const clonePath = await fixture.cloneSecond();
			await Bun.$`git -C ${clonePath} checkout -q feat`.quiet();
			const pushedSha = await pushCommit(clonePath, "feat.txt", "remote moved ahead");

			await withCwd(fixture.repoPath, async () => {
				const localGit = createBunGitAdapter(createNoopLogger());
				expectOk(await localGit.updateBranchRef("feat"));
				const localSha = (await Bun.$`git -C ${fixture.repoPath} rev-parse feat`.quiet().text()).trim();
				expect(localSha).toBe(pushedSha);
			});
		});

		test("deleteRemoteBranch without an explicit remote pushes the delete to the resolved remote", async () => {
			await using tmp = await createTempDir();
			const fixture = await createRemoteFixture(tmp.path, { remoteName: "upstream" });
			await fixture.addTrackedBranch("doomed");

			await withCwd(fixture.repoPath, async () => {
				const localGit = createBunGitAdapter(createNoopLogger());
				expectOk(await localGit.deleteRemoteBranch("doomed"));
				const remoteRefs = await Bun.$`git -C ${fixture.remotePath} branch --list doomed`.quiet().text();
				expect(remoteRefs.trim()).toBe("");
			});
		});

		test("createWorktreeFromRemote without an explicit remote checks out via the resolved non-origin remote", async () => {
			await using tmp = await createTempDir();
			const fixture = await createRemoteFixture(tmp.path, { remoteName: "upstream" });
			const clonePath = await fixture.cloneSecond();
			await Bun.$`git -C ${clonePath} checkout -q -b remote-only`.quiet();
			await Bun.$`git -C ${clonePath} push -u upstream remote-only`.quiet();
			const wtPath = join(tmp.path, "wt-remote");

			await withCwd(fixture.repoPath, async () => {
				const localGit = createBunGitAdapter(createNoopLogger());
				expectOk(await localGit.fetchAll());
				expect(expectOk(await localGit.branchExists("remote-only"))).toBe(false);

				const worktree = expectOk(await localGit.createWorktreeFromRemote("remote-only", wtPath));
				expect(worktree.branch).toBe("remote-only");

				const upstream = await Bun.$`git -C ${wtPath} rev-parse --abbrev-ref ${"remote-only@{upstream}"}`
					.quiet()
					.text();
				expect(upstream.trim()).toBe("upstream/remote-only");
			});
		});

		test("multiple remotes: the one tracking the default branch wins over the disambiguation fallbacks", async () => {
			await using tmp = await createTempDir();
			const fixture = await createRemoteFixture(tmp.path, { remoteName: "upstream" });
			// Second remote, pushed to and fetched so it produces remote-tracking
			// refs. A naive "single remote or alphabetical" picker would prefer
			// "aaa" — but branch.main.remote points to "upstream".
			const otherBare = join(tmp.path, "other.git");
			await Bun.$`git init --bare -b main ${otherBare}`.quiet();
			await Bun.$`git -C ${fixture.repoPath} remote add aaa ${otherBare}`.quiet();
			await Bun.$`git -C ${fixture.repoPath} push aaa main`.quiet();
			await Bun.$`git -C ${fixture.repoPath} fetch aaa`.quiet();

			await withCwd(fixture.repoPath, async () => {
				const localGit = createBunGitAdapter(createNoopLogger());
				// Both remotes now have a main ref. listRemoteBranches strips
				// only "upstream/", so the "aaa/main" entry survives — proving
				// resolution followed branch.main.remote rather than picking aaa.
				const branches = expectOk(await localGit.listRemoteBranches());
				expect(branches).toContain("main");
				expect(branches).toContain("aaa/main");
				expect(branches).not.toContain("upstream/main");
			});
		});

		test("repo with no remote configured: methods fall back to 'origin' and fail with MERGE_FAILED, not silently", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);

			await withCwd(repoPath, async () => {
				const localGit = createBunGitAdapter(createNoopLogger());
				// No remote exists at all — the operation must surface a typed
				// error rather than crashing or returning a misleading success.
				const result = await localGit.updateBranchRef("main");
				expect(result.success).toBe(false);
				if (!result.success) {
					expect(result.error.code).toBe("MERGE_FAILED");
				}
			});
		});
	});

	// === Edge cases ===

	describe("edge cases", () => {
		test("unborn repo: default-branch and commit-count queries fail with Result errors", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initUnbornRepo(tmp.path);

			await withCwd(repoPath, async () => {
				expectErr(await git.getDefaultBranch());
				expectErr(await git.getCommitCount("main", "main"));
			});
		});

		test("detached-HEAD worktree is listed with an empty branch", async () => {
			await using tmp = await createTempDir();
			const repoPath = await initTestRepo(tmp.path);
			const headSha = (await Bun.$`git -C ${repoPath} rev-parse HEAD`.quiet().text()).trim();
			const wtPath = join(tmp.path, "wt-detached");
			await Bun.$`git -C ${repoPath} worktree add --detach ${wtPath} ${headSha}`.quiet();

			await withCwd(repoPath, async () => {
				const worktrees = expectOk(await git.listWorktrees());
				const detached = worktrees.find((w) => w.path.includes("wt-detached"));
				expect(detached).toBeDefined();
				expect(detached?.branch).toBe("");
				expect(detached?.head).toBe(headSha);
			});
		});

		test("branch names with slashes survive the full gone-branch flow", async () => {
			await using tmp = await createTempDir();
			const fixture = await createRemoteFixture(tmp.path);
			await fixture.addTrackedBranch("feature/nested-x", { withCommit: true });
			await fixture.deleteRemoteBranch("feature/nested-x");

			await withCwd(fixture.repoPath, async () => {
				expectOk(await git.fetchPrune());
				expect(expectOk(await git.listGoneBranches())).toEqual(["feature/nested-x"]);
				expectOk(await git.deleteBranchForce("feature/nested-x"));
				expect(expectOk(await git.branchExists("feature/nested-x"))).toBe(false);
			});
		});
	});
});
