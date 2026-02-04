import { describe, expect, test } from "bun:test";
import type { Worktree } from "../../domain/entities/worktree.ts";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { listWorktrees } from "./list-worktrees.ts";

describe("listWorktrees", () => {
	test("returns empty array when no worktrees exist", async () => {
		const git = createFakeGit({ worktrees: [] });
		const result = await listWorktrees({ git });

		const { worktrees } = expectOk(result);
		expect(worktrees).toEqual([]);
	});

	test("returns all worktrees from git port", async () => {
		const existing: Worktree[] = [
			{ path: "/repo", branch: "main", head: "abc", isMain: true },
			{ path: "/repo-feature", branch: "feature", head: "def", isMain: false },
		];
		const git = createFakeGit({ worktrees: existing });
		const result = await listWorktrees({ git });

		const { worktrees } = expectOk(result);
		expect(worktrees).toHaveLength(2);
		expect(worktrees[0]?.branch).toBe("main");
		expect(worktrees[1]?.branch).toBe("feature");
	});

	test("returns error when not in a git repository", async () => {
		const git = createFakeGit({ isRepo: false });
		const result = await listWorktrees({ git });

		expectErr(result);
	});
});
