import { describe, expect, test } from "bun:test";
import type { Worktree } from "../../domain/entities/worktree.ts";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { removeWorktree } from "./remove-worktree.ts";

describe("removeWorktree", () => {
	const main: Worktree = { path: "/repo", branch: "main", head: "abc", isMain: true, isPrunable: false };
	const feature: Worktree = {
		path: "/repo-feature",
		branch: "feature",
		head: "def",
		isMain: false,
		isPrunable: false,
	};

	test("removes healthy worktree by path and returns removed path", async () => {
		const git = createFakeGit({ worktrees: [main, feature] });
		const result = await removeWorktree({ worktree: feature }, { git });

		const output = expectOk(result);
		expect(output.removedPath).toBe("/repo-feature");
		expect(output.pruned).toBe(false);

		const remaining = expectOk(await git.listWorktrees());
		expect(remaining.find((w) => w.path === "/repo-feature")).toBeUndefined();
	});

	test("returns error when trying to remove main worktree", async () => {
		const git = createFakeGit({ worktrees: [main, feature] });
		const result = await removeWorktree({ worktree: main }, { git });

		expectErr(result);
	});

	test("prunes orphaned worktree with branch", async () => {
		const orphan: Worktree = {
			path: "/repo-orphan",
			branch: "orphan-branch",
			head: "ddd",
			isMain: false,
			isPrunable: true,
			prunableReason: "gitdir file points to non-existent location",
		};
		const git = createFakeGit({ worktrees: [main, orphan] });

		const result = await removeWorktree({ worktree: orphan }, { git });
		const output = expectOk(result);
		expect(output.removedPath).toBe("/repo-orphan");
		expect(output.pruned).toBe(true);

		const remaining = expectOk(await git.listWorktrees());
		expect(remaining.find((w) => w.path === "/repo-orphan")).toBeUndefined();
	});

	test("prunes orphaned detached-HEAD worktree (empty branch)", async () => {
		const orphan: Worktree = {
			path: "/repo-detached",
			branch: "",
			head: "eee",
			isMain: false,
			isPrunable: true,
		};
		const git = createFakeGit({ worktrees: [main, orphan] });

		const result = await removeWorktree({ worktree: orphan }, { git });
		const output = expectOk(result);
		expect(output.removedPath).toBe("/repo-detached");
		expect(output.pruned).toBe(true);
	});

	test("returns actionable error with unlock command when worktree is locked", async () => {
		const git = createFakeGit({
			worktrees: [main, feature],
			lockedWorktrees: new Map([[feature.path, "claude agent task-xyz (pid 1234)"]]),
		});

		const result = await removeWorktree({ worktree: feature }, { git });
		const error = expectErr(result);

		expect(error.message).toContain(feature.path);
		expect(error.message).toContain(`git worktree unlock "${feature.path}"`);
		expect(error.message).toContain("claude agent task-xyz (pid 1234)");
		expect(error.message).toContain("retry wt remove");

		// Locked worktree must not be removed.
		const remaining = expectOk(await git.listWorktrees());
		expect(remaining.find((w) => w.path === feature.path)).toBeDefined();
	});

	test("pruning one orphan does not affect other orphans", async () => {
		const orphanA: Worktree = {
			path: "/repo-orphan-a",
			branch: "orphan-a",
			head: "aaa",
			isMain: false,
			isPrunable: true,
		};
		const orphanB: Worktree = {
			path: "/repo-orphan-b",
			branch: "orphan-b",
			head: "bbb",
			isMain: false,
			isPrunable: true,
		};
		const git = createFakeGit({ worktrees: [main, orphanA, orphanB] });

		const result = await removeWorktree({ worktree: orphanA }, { git });
		expectOk(result);

		const remaining = expectOk(await git.listWorktrees());
		expect(remaining.find((w) => w.path === "/repo-orphan-a")).toBeUndefined();
		expect(remaining.find((w) => w.path === "/repo-orphan-b")).toBeDefined();
	});
});
