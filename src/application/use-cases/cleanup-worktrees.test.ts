import { describe, expect, test } from "bun:test";
import type { Worktree } from "../../domain/entities/worktree.ts";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { cleanupWorktrees } from "./cleanup-worktrees.ts";

const mainWt: Worktree = { path: "/repo", branch: "main", head: "aaa", isMain: true };
const featureA: Worktree = { path: "/wt/feature-a", branch: "feature-a", head: "bbb", isMain: false };
const featureB: Worktree = { path: "/wt/feature-b", branch: "feature-b", head: "ccc", isMain: false };

describe("cleanupWorktrees", () => {
	test("gone merged branches with worktrees — cleaned", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA, featureB],
			branches: ["main", "feature-a", "feature-b"],
			goneBranches: ["feature-a", "feature-b"],
			mergedBranches: ["feature-a", "feature-b"],
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports).toHaveLength(2);
		expect(output.reports[0]).toMatchObject({ branch: "feature-a", result: { status: "cleaned" } });
		expect(output.reports[1]).toMatchObject({ branch: "feature-b", result: { status: "cleaned" } });
	});

	test("no gone branches — empty reports", async () => {
		const git = createFakeGit({ worktrees: [mainWt, featureA], goneBranches: [] });
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports).toHaveLength(0);
	});

	test("unmerged branch without --force — skipped", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			branches: ["main", "feature-a"],
			goneBranches: ["feature-a"],
			mergedBranches: [],
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports[0]).toMatchObject({ branch: "feature-a", result: { status: "skipped-unmerged" } });
	});

	test("unmerged branch with --force — force deleted", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			branches: ["main", "feature-a"],
			goneBranches: ["feature-a"],
			mergedBranches: [],
		});
		const output = expectOk(await cleanupWorktrees({ force: true, dryRun: false }, { git }));

		expect(output.reports[0]).toMatchObject({ branch: "feature-a", result: { status: "cleaned" } });
	});

	test("dirty worktree without --force — skipped", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			goneBranches: ["feature-a"],
			mergedBranches: ["feature-a"],
			dirtyWorktrees: new Set(["/wt/feature-a"]),
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports[0]).toMatchObject({ branch: "feature-a", result: { status: "skipped-dirty" } });
	});

	test("dry-run — reports candidates without deleting", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			goneBranches: ["feature-a"],
			mergedBranches: ["feature-a"],
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: true }, { git }));

		expect(output.reports[0]).toMatchObject({ branch: "feature-a", worktreePath: "/wt/feature-a", result: { status: "dry-run" } });

		// worktree still exists
		const remaining = await git.listWorktrees();
		expect(remaining.success && remaining.data).toHaveLength(2);
	});

	test("default branch is never cleaned", async () => {
		const git = createFakeGit({ worktrees: [mainWt], goneBranches: ["main"], mergedBranches: ["main"] });
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports).toHaveLength(0);
	});

	test("fetch failure — returns error", async () => {
		const git = createFakeGit({ worktrees: [mainWt], goneBranches: ["feature-a"], fetchFails: true });
		const error = expectErr(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(error.message).toContain("Fetch failed");
	});
});
