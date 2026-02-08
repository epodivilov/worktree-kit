import { describe, expect, test } from "bun:test";
import type { Worktree } from "../../domain/entities/worktree.ts";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { updateWorktrees } from "./update-worktrees.ts";

const mainWt: Worktree = { path: "/repo", branch: "main", head: "aaa", isMain: true };
const featureA: Worktree = { path: "/repo-a", branch: "feature-a", head: "bbb", isMain: false };
const featureB: Worktree = { path: "/repo-b", branch: "feature-b", head: "ccc", isMain: false };

describe("updateWorktrees", () => {
	test("happy path: fetch + ff + rebase all feature branches", async () => {
		const git = createFakeGit({ worktrees: [mainWt, featureA, featureB] });
		const result = await updateWorktrees({ skipRebase: false }, { git });

		const output = expectOk(result);
		expect(output.defaultBranch).toBe("main");
		expect(output.defaultBranchUpdate).toBe("ff-updated");
		expect(output.reports).toHaveLength(3);
		expect(output.reports[0]).toMatchObject({ branch: "main", result: { status: "is-default-branch" } });
		expect(output.reports[1]).toMatchObject({ branch: "feature-a", result: { status: "rebased" } });
		expect(output.reports[2]).toMatchObject({ branch: "feature-b", result: { status: "rebased" } });
	});

	test("default branch not checked out — uses ref update", async () => {
		const git = createFakeGit({ worktrees: [featureA] });
		const result = await updateWorktrees({ skipRebase: false }, { git });

		const output = expectOk(result);
		expect(output.defaultBranchUpdate).toBe("ref-updated");
	});

	test("fetch failure — returns error", async () => {
		const git = createFakeGit({ worktrees: [mainWt], fetchFails: true });
		const result = await updateWorktrees({ skipRebase: false }, { git });

		const error = expectErr(result);
		expect(error.message).toContain("Fetch failed");
	});

	test("ff-only failure — returns error, no rebase", async () => {
		const git = createFakeGit({ worktrees: [mainWt, featureA], mergeFFOnlyFails: true });
		const result = await updateWorktrees({ skipRebase: false }, { git });

		const error = expectErr(result);
		expect(error.message).toContain("Failed to fast-forward");
	});

	test("dirty worktree — skipped with warning", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA, featureB],
			dirtyWorktrees: new Set(["/repo-a"]),
		});
		const result = await updateWorktrees({ skipRebase: false }, { git });

		const output = expectOk(result);
		expect(output.reports[1]).toMatchObject({ branch: "feature-a", result: { status: "skipped-dirty" } });
		expect(output.reports[2]).toMatchObject({ branch: "feature-b", result: { status: "rebased" } });
	});

	test("rebase conflict — abort and continue", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA, featureB],
			rebaseConflicts: new Set(["/repo-a"]),
		});
		const result = await updateWorktrees({ skipRebase: false }, { git });

		const output = expectOk(result);
		expect(output.reports[1]).toMatchObject({ branch: "feature-a", result: { status: "rebase-conflict" } });
		expect(output.reports[2]).toMatchObject({ branch: "feature-b", result: { status: "rebased" } });
	});

	test("--no-rebase — all feature branches skipped", async () => {
		const git = createFakeGit({ worktrees: [mainWt, featureA, featureB] });
		const result = await updateWorktrees({ skipRebase: true }, { git });

		const output = expectOk(result);
		expect(output.defaultBranchUpdate).toBe("ff-updated");
		expect(output.reports[1]).toMatchObject({ branch: "feature-a", result: { status: "skipped-rebase" } });
		expect(output.reports[2]).toMatchObject({ branch: "feature-b", result: { status: "skipped-rebase" } });
	});

	test("detached HEAD worktree — silently skipped", async () => {
		const detached: Worktree = { path: "/repo-detached", branch: "", head: "ddd", isMain: false };
		const git = createFakeGit({ worktrees: [mainWt, detached, featureA] });
		const result = await updateWorktrees({ skipRebase: false }, { git });

		const output = expectOk(result);
		expect(output.reports).toHaveLength(2);
		expect(output.reports[0]).toMatchObject({ branch: "main", result: { status: "is-default-branch" } });
		expect(output.reports[1]).toMatchObject({ branch: "feature-a", result: { status: "rebased" } });
	});
});
