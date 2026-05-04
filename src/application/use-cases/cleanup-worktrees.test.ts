import { describe, expect, test } from "bun:test";
import type { Worktree } from "../../domain/entities/worktree.ts";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { cleanupWorktrees } from "./cleanup-worktrees.ts";

const mainWt: Worktree = { path: "/repo", branch: "main", head: "aaa", isMain: true, isPrunable: false };
const featureA: Worktree = {
	path: "/wt/feature-a",
	branch: "feature-a",
	head: "bbb",
	isMain: false,
	isPrunable: false,
};
const featureB: Worktree = {
	path: "/wt/feature-b",
	branch: "feature-b",
	head: "ccc",
	isMain: false,
	isPrunable: false,
};

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

	test("no gone branches and no orphans — empty reports", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			branches: ["main", "feature-a"],
			goneBranches: [],
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports).toHaveLength(0);
	});

	test("no gone branches but orphaned worktree — orphan-cleaned", async () => {
		const orphanWt: Worktree = {
			path: "/wt/orphan",
			branch: "deleted-branch",
			head: "ddd",
			isMain: false,
			isPrunable: false,
		};
		const git = createFakeGit({
			worktrees: [mainWt, orphanWt],
			branches: ["main"],
			goneBranches: [],
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports).toHaveLength(1);
		expect(output.reports[0]).toMatchObject({
			branch: "deleted-branch",
			worktreePath: "/wt/orphan",
			result: { status: "orphan-cleaned" },
		});
	});

	test("unmerged branch without --force — skipped", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			branches: ["main", "feature-a"],
			goneBranches: ["feature-a"],
			mergedBranches: [],
			commitCountMap: new Map([["main..feature-a", 3]]),
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
			commitCountMap: new Map([["main..feature-a", 3]]),
		});
		const output = expectOk(await cleanupWorktrees({ force: true, dryRun: false }, { git }));

		expect(output.reports[0]).toMatchObject({ branch: "feature-a", result: { status: "cleaned" } });
	});

	test("squash-merged gone branch (0 commits ahead) — cleaned without force", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			branches: ["main", "feature-a"],
			goneBranches: ["feature-a"],
			mergedBranches: [],
			commitCountMap: new Map([["main..feature-a", 0]]),
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports[0]).toMatchObject({ branch: "feature-a", result: { status: "cleaned" } });
	});

	test("dirty worktree without --force — skipped", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			branches: ["main", "feature-a"],
			goneBranches: ["feature-a"],
			mergedBranches: ["feature-a"],
			dirtyWorktrees: new Set(["/wt/feature-a"]),
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports[0]).toMatchObject({ branch: "feature-a", result: { status: "skipped-dirty" } });
	});

	test("dirty worktree with --force — force removed and cleaned", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			branches: ["main", "feature-a"],
			goneBranches: ["feature-a"],
			mergedBranches: ["feature-a"],
			dirtyWorktrees: new Set(["/wt/feature-a"]),
		});
		const output = expectOk(await cleanupWorktrees({ force: true, dryRun: false }, { git }));

		expect(output.reports[0]).toMatchObject({ branch: "feature-a", result: { status: "cleaned" } });
	});

	test("dry-run — reports candidates without deleting", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			branches: ["main", "feature-a"],
			goneBranches: ["feature-a"],
			mergedBranches: ["feature-a"],
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: true }, { git }));

		expect(output.reports[0]).toMatchObject({
			branch: "feature-a",
			worktreePath: "/wt/feature-a",
			result: { status: "dry-run" },
		});

		// worktree still exists
		const remaining = await git.listWorktrees();
		expect(remaining.success && remaining.data).toHaveLength(2);
	});

	test("default branch is never cleaned", async () => {
		const git = createFakeGit({
			worktrees: [mainWt],
			branches: ["main"],
			goneBranches: ["main"],
			mergedBranches: ["main"],
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports).toHaveLength(0);
	});

	test("fetch failure — returns error", async () => {
		const git = createFakeGit({ worktrees: [mainWt], goneBranches: ["feature-a"], fetchFails: true });
		const error = expectErr(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(error.message).toContain("Fetch failed");
	});

	test("orphaned worktree (branch deleted externally) — orphan-cleaned", async () => {
		const orphanWt: Worktree = {
			path: "/wt/orphan",
			branch: "deleted-branch",
			head: "ddd",
			isMain: false,
			isPrunable: false,
		};
		const git = createFakeGit({
			worktrees: [mainWt, featureA, orphanWt],
			branches: ["main", "feature-a"],
			goneBranches: ["feature-a"],
			mergedBranches: ["feature-a"],
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports).toHaveLength(2);
		expect(output.reports[0]).toMatchObject({ branch: "feature-a", result: { status: "cleaned" } });
		expect(output.reports[1]).toMatchObject({
			branch: "deleted-branch",
			worktreePath: "/wt/orphan",
			result: { status: "orphan-cleaned" },
		});
	});

	test("dirty orphaned worktree without --force — orphan-skipped-dirty", async () => {
		const orphanWt: Worktree = {
			path: "/wt/orphan",
			branch: "deleted-branch",
			head: "ddd",
			isMain: false,
			isPrunable: false,
		};
		const git = createFakeGit({
			worktrees: [mainWt, orphanWt],
			branches: ["main", "some-gone"],
			goneBranches: ["some-gone"],
			mergedBranches: ["some-gone"],
			dirtyWorktrees: new Set(["/wt/orphan"]),
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports[1]).toMatchObject({
			branch: "deleted-branch",
			result: { status: "orphan-skipped-dirty" },
		});
	});

	test("dirty orphaned worktree with --force — orphan-cleaned", async () => {
		const orphanWt: Worktree = {
			path: "/wt/orphan",
			branch: "deleted-branch",
			head: "ddd",
			isMain: false,
			isPrunable: false,
		};
		const git = createFakeGit({
			worktrees: [mainWt, orphanWt],
			branches: ["main", "some-gone"],
			goneBranches: ["some-gone"],
			mergedBranches: ["some-gone"],
			dirtyWorktrees: new Set(["/wt/orphan"]),
		});
		const output = expectOk(await cleanupWorktrees({ force: true, dryRun: false }, { git }));

		expect(output.reports[1]).toMatchObject({
			branch: "deleted-branch",
			result: { status: "orphan-cleaned" },
		});
	});

	test("orphaned worktree in dry-run — orphan-dry-run", async () => {
		const orphanWt: Worktree = {
			path: "/wt/orphan",
			branch: "deleted-branch",
			head: "ddd",
			isMain: false,
			isPrunable: false,
		};
		const git = createFakeGit({
			worktrees: [mainWt, featureA, orphanWt],
			branches: ["main", "feature-a"],
			goneBranches: ["feature-a"],
			mergedBranches: ["feature-a"],
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: true }, { git }));

		const orphanReport = output.reports.find((r) => r.result.status === "orphan-dry-run");
		expect(orphanReport).toMatchObject({
			branch: "deleted-branch",
			worktreePath: "/wt/orphan",
		});

		const remaining = await git.listWorktrees();
		expect(remaining.success && remaining.data).toHaveLength(3);
	});

	test("detached HEAD worktree — orphan-cleaned", async () => {
		const detachedWt: Worktree = { path: "/wt/detached", branch: "", head: "ddd", isMain: false, isPrunable: false };
		const git = createFakeGit({
			worktrees: [mainWt, detachedWt],
			branches: ["main"],
			goneBranches: [],
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports).toHaveLength(1);
		expect(output.reports[0]).toMatchObject({
			branch: "",
			worktreePath: "/wt/detached",
			result: { status: "orphan-cleaned" },
		});
	});

	test("dirty detached HEAD worktree without --force — orphan-skipped-dirty", async () => {
		const detachedWt: Worktree = { path: "/wt/detached", branch: "", head: "ddd", isMain: false, isPrunable: false };
		const git = createFakeGit({
			worktrees: [mainWt, detachedWt],
			branches: ["main"],
			goneBranches: [],
			dirtyWorktrees: new Set(["/wt/detached"]),
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports).toHaveLength(1);
		expect(output.reports[0]).toMatchObject({
			branch: "",
			worktreePath: "/wt/detached",
			result: { status: "orphan-skipped-dirty" },
		});
	});

	test("main worktree is never treated as orphan", async () => {
		const weirdMain: Worktree = { path: "/repo", branch: "weird", head: "aaa", isMain: true, isPrunable: false };
		const git = createFakeGit({
			worktrees: [weirdMain],
			branches: ["main", "some-branch"],
			goneBranches: ["some-branch"],
			mergedBranches: ["some-branch"],
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports).toHaveLength(1);
		expect(output.reports[0]).toMatchObject({ branch: "some-branch", result: { status: "branch-only" } });
	});
});
