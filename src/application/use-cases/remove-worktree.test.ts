import { describe, expect, test } from "bun:test";
import type { Worktree } from "../../domain/entities/worktree.ts";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { removeWorktree } from "./remove-worktree.ts";

describe("removeWorktree", () => {
	const worktrees: Worktree[] = [
		{ path: "/repo", branch: "main", head: "abc", isMain: true },
		{ path: "/repo-feature", branch: "feature", head: "def", isMain: false },
	];

	test("removes worktree by branch name and returns removed path", async () => {
		const git = createFakeGit({ worktrees: [...worktrees] });
		const result = await removeWorktree({ branch: "feature" }, { git });

		const { removedPath } = expectOk(result);
		expect(removedPath).toBe("/repo-feature");
	});

	test("returns error when branch not found", async () => {
		const git = createFakeGit({ worktrees: [...worktrees] });
		const result = await removeWorktree({ branch: "nonexistent" }, { git });

		expectErr(result);
	});

	test("returns error when trying to remove main worktree", async () => {
		const git = createFakeGit({ worktrees: [...worktrees] });
		const result = await removeWorktree({ branch: "main" }, { git });

		expectErr(result);
	});

	test("returns error when not in a git repository", async () => {
		const git = createFakeGit({ isRepo: false });
		const result = await removeWorktree({ branch: "feature" }, { git });

		expectErr(result);
	});
});
