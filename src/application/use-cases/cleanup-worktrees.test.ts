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
			commitCountMap: new Map([
				["main..feature-a", 0],
				["main..feature-b", 0],
			]),
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports).toHaveLength(2);
		expect(output.reports[0]).toMatchObject({ branch: "feature-a", result: { status: "cleaned" } });
		expect(output.reports[1]).toMatchObject({ branch: "feature-b", result: { status: "cleaned" } });
	});

	test("allow-list — only listed gone branches are processed", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA, featureB],
			branches: ["main", "feature-a", "feature-b"],
			goneBranches: ["feature-a", "feature-b"],
			mergedBranches: ["feature-a", "feature-b"],
			commitCountMap: new Map([
				["main..feature-a", 0],
				["main..feature-b", 0],
			]),
		});
		const output = expectOk(
			await cleanupWorktrees({ force: false, dryRun: false, skipOrphans: true, branches: ["feature-a"] }, { git }),
		);

		expect(output.reports).toHaveLength(1);
		expect(output.reports[0]).toMatchObject({ branch: "feature-a", result: { status: "cleaned" } });
		expect(expectOk(await git.branchExists("feature-b"))).toBe(true);
	});

	test("empty allow-list — no gone branches are processed", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			branches: ["main", "feature-a"],
			goneBranches: ["feature-a"],
			mergedBranches: ["feature-a"],
			commitCountMap: new Map([["main..feature-a", 0]]),
		});
		const output = expectOk(
			await cleanupWorktrees({ force: false, dryRun: false, skipOrphans: true, branches: [] }, { git }),
		);

		expect(output.reports).toHaveLength(0);
		expect(expectOk(await git.branchExists("feature-a"))).toBe(true);
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

	test("cherry-picked gone branch with commits ahead — cleaned without force", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			branches: ["main", "feature-a"],
			goneBranches: ["feature-a"],
			mergedBranches: [],
			commitCountMap: new Map([["main..feature-a", 2]]),
			revListMap: new Map([["main..feature-a", ["sha1", "sha2"]]]),
			revListCherryPickMap: new Map([["main...feature-a", []]]),
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports[0]).toMatchObject({ branch: "feature-a", result: { status: "cleaned" } });
	});

	test("squash-merged gone branch with commits ahead — cleaned without force", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			branches: ["main", "feature-a"],
			goneBranches: ["feature-a"],
			mergedBranches: [],
			commitCountMap: new Map([["main..feature-a", 2]]),
			revListMap: new Map([
				["main..feature-a", ["sha1", "sha2"]],
				["feature-a..main", ["squash-sha"]],
			]),
			revListCherryPickMap: new Map([["main...feature-a", ["sha1", "sha2"]]]),
			mergeBaseMap: new Map([["main:feature-a", "merge-base"]]),
			diffTreeFilesMap: new Map([
				["sha1", ["a.ts", "b.ts"]],
				["sha2", ["b.ts"]],
				["squash-sha", ["a.ts", "b.ts"]],
			]),
			diffNormalizedMap: new Map([
				["squash-sha^..squash-sha", "DIFF"],
				["merge-base..sha1", "DIFF"],
			]),
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports[0]).toMatchObject({ branch: "feature-a", result: { status: "cleaned" } });
	});

	test("unmerged branch with unique commits and no prefix match — skipped-unmerged", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			branches: ["main", "feature-a"],
			goneBranches: ["feature-a"],
			mergedBranches: [],
			commitCountMap: new Map([["main..feature-a", 2]]),
			revListMap: new Map([
				["main..feature-a", ["sha1", "sha2"]],
				["feature-a..main", []],
			]),
			revListCherryPickMap: new Map([["main...feature-a", ["sha1", "sha2"]]]),
			mergeBaseMap: new Map([["main:feature-a", "merge-base"]]),
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports[0]).toMatchObject({ branch: "feature-a", result: { status: "skipped-unmerged" } });
	});

	test("dirty worktree without --force — skipped and worktree preserved", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			branches: ["main", "feature-a"],
			goneBranches: ["feature-a"],
			mergedBranches: ["feature-a"],
			dirtyWorktrees: new Set(["/wt/feature-a"]),
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports[0]).toMatchObject({ branch: "feature-a", result: { status: "skipped-dirty" } });
		const remaining = await git.listWorktrees();
		expect(remaining.success && remaining.data.some((w) => w.path === "/wt/feature-a")).toBe(true);
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

	test("unmerged branch with worktree (clean) — skipped-unmerged and worktree preserved", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			branches: ["main", "feature-a"],
			goneBranches: ["feature-a"],
			mergedBranches: [],
			commitCountMap: new Map([["main..feature-a", 2]]),
			revListMap: new Map([
				["main..feature-a", ["sha1", "sha2"]],
				["feature-a..main", []],
			]),
			revListCherryPickMap: new Map([["main...feature-a", ["sha1", "sha2"]]]),
			mergeBaseMap: new Map([["main:feature-a", "merge-base"]]),
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports[0]).toMatchObject({ branch: "feature-a", result: { status: "skipped-unmerged" } });
		const remaining = await git.listWorktrees();
		expect(remaining.success && remaining.data.some((w) => w.path === "/wt/feature-a")).toBe(true);
	});

	test("dry-run — reports candidates without deleting", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			branches: ["main", "feature-a"],
			goneBranches: ["feature-a"],
			mergedBranches: ["feature-a"],
			commitCountMap: new Map([["main..feature-a", 0]]),
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

	test("dry-run — classification predicts the real outcome per branch", async () => {
		const dirtyWt: Worktree = { path: "/wt/dirty-b", branch: "dirty-b", head: "ddd", isMain: false, isPrunable: false };
		const git = createFakeGit({
			worktrees: [mainWt, featureA, dirtyWt],
			branches: ["main", "feature-a", "unmerged-b", "dirty-b"],
			goneBranches: ["feature-a", "unmerged-b", "dirty-b"],
			mergedBranches: ["feature-a"],
			dirtyWorktrees: new Set(["/wt/dirty-b"]),
			commitCountMap: new Map([
				["main..feature-a", 0],
				["main..unmerged-b", 2],
			]),
			revListMap: new Map([["main..unmerged-b", ["sha1", "sha2"]]]),
			revListCherryPickMap: new Map([["main...unmerged-b", ["sha1", "sha2"]]]),
			mergeBaseMap: new Map([["main:unmerged-b", "merge-base"]]),
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: true, skipOrphans: true }, { git }));

		const byBranch = new Map(output.reports.map((r) => [r.branch, r.result.status]));
		expect(byBranch.get("feature-a")).toBe("dry-run");
		expect(byBranch.get("unmerged-b")).toBe("skipped-unmerged");
		expect(byBranch.get("dirty-b")).toBe("skipped-dirty");
		// Nothing was deleted.
		expect(expectOk(await git.branchExists("feature-a"))).toBe(true);
		expect(expectOk(await git.branchExists("unmerged-b"))).toBe(true);
	});

	test("dry-run — dirty orphaned worktree predicted as skipped", async () => {
		const orphanWt: Worktree = {
			path: "/wt/orphan",
			branch: "gone-branch",
			head: "eee",
			isMain: false,
			isPrunable: false,
		};
		const git = createFakeGit({
			worktrees: [mainWt, orphanWt],
			branches: ["main"],
			goneBranches: [],
			dirtyWorktrees: new Set(["/wt/orphan"]),
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: true }, { git }));

		expect(output.reports).toHaveLength(1);
		expect(output.reports[0]).toMatchObject({
			branch: "gone-branch",
			result: { status: "orphan-skipped-dirty" },
		});
	});

	test("branch deletion failure surfaces as error report", async () => {
		// Unmerged branch → force fallback. Stub deleteBranchForce to fail so the
		// delete-branch use case returns `failed`, which cleanup must surface as
		// an `error` report.
		const baseGit = createFakeGit({
			worktrees: [mainWt, featureA],
			branches: ["main", "feature-a"],
			goneBranches: ["feature-a"],
			mergedBranches: [],
			commitCountMap: new Map([["main..feature-a", 3]]),
		});
		const git = {
			...baseGit,
			async deleteBranchForce(_branch: string) {
				return { success: false as const, error: { code: "UNKNOWN" as const, message: "force boom" } };
			},
		};
		const output = expectOk(await cleanupWorktrees({ force: true, dryRun: false }, { git }));

		expect(output.reports[0]).toMatchObject({
			branch: "feature-a",
			result: { status: "error", message: "force boom" },
		});
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
			commitCountMap: new Map([["main..feature-a", 0]]),
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
			commitCountMap: new Map([["main..some-branch", 0]]),
		});
		const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

		expect(output.reports).toHaveLength(1);
		expect(output.reports[0]).toMatchObject({ branch: "some-branch", result: { status: "branch-only" } });
	});

	describe("non-[gone] fully-merged branches with active worktrees", () => {
		test("cherry-picked branch with worktree (not [gone]) — cleaned", async () => {
			const git = createFakeGit({
				worktrees: [mainWt, featureA],
				branches: ["main", "feature-a"],
				goneBranches: [],
				mergedBranches: ["feature-a"],
				commitCountMap: new Map([["main..feature-a", 2]]),
				revListMap: new Map([["main..feature-a", ["sha1", "sha2"]]]),
				revListCherryPickMap: new Map([["main...feature-a", []]]),
			});
			const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

			expect(output.reports).toHaveLength(1);
			expect(output.reports[0]).toMatchObject({
				branch: "feature-a",
				worktreePath: "/wt/feature-a",
				result: { status: "cleaned" },
			});
			const remaining = await git.listWorktrees();
			expect(remaining.success && remaining.data.some((w) => w.path === "/wt/feature-a")).toBe(false);
		});

		test("squash-merged branch with worktree (not [gone]) — cleaned", async () => {
			const git = createFakeGit({
				worktrees: [mainWt, featureA],
				branches: ["main", "feature-a"],
				goneBranches: [],
				mergedBranches: ["feature-a"],
				commitCountMap: new Map([["main..feature-a", 2]]),
				revListMap: new Map([
					["main..feature-a", ["sha1", "sha2"]],
					["feature-a..main", ["squash-sha"]],
				]),
				revListCherryPickMap: new Map([["main...feature-a", ["sha1", "sha2"]]]),
				mergeBaseMap: new Map([["main:feature-a", "merge-base"]]),
				diffTreeFilesMap: new Map([
					["sha1", ["a.ts", "b.ts"]],
					["sha2", ["b.ts"]],
					["squash-sha", ["a.ts", "b.ts"]],
				]),
				diffNormalizedMap: new Map([
					["squash-sha^..squash-sha", "DIFF"],
					["merge-base..sha1", "DIFF"],
				]),
			});
			const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

			expect(output.reports).toHaveLength(1);
			expect(output.reports[0]).toMatchObject({
				branch: "feature-a",
				result: { status: "cleaned" },
			});
		});

		test("only partially cherry-picked branch with worktree (not [gone]) — not in reports", async () => {
			const git = createFakeGit({
				worktrees: [mainWt, featureA],
				branches: ["main", "feature-a"],
				goneBranches: [],
				mergedBranches: [],
				commitCountMap: new Map([["main..feature-a", 2]]),
				revListMap: new Map([
					["main..feature-a", ["sha1", "sha2"]],
					["feature-a..main", []],
				]),
				revListCherryPickMap: new Map([["main...feature-a", ["sha1", "sha2"]]]),
				mergeBaseMap: new Map([["main:feature-a", "merge-base"]]),
			});
			const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

			expect(output.reports).toHaveLength(0);
			// Worktree is preserved.
			const remaining = await git.listWorktrees();
			expect(remaining.success && remaining.data.some((w) => w.path === "/wt/feature-a")).toBe(true);
		});

		test("non-[gone] merged branch WITHOUT worktree — not touched (out of scope)", async () => {
			// feature-b is fully merged in the default branch sense but has no worktree
			// and no [gone] marker → should be ignored.
			const git = createFakeGit({
				worktrees: [mainWt],
				branches: ["main", "feature-b"],
				goneBranches: [],
				mergedBranches: ["feature-b"],
				commitCountMap: new Map([["main..feature-b", 2]]),
				revListMap: new Map([["main..feature-b", ["sha1", "sha2"]]]),
				revListCherryPickMap: new Map([["main...feature-b", []]]),
			});
			const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

			expect(output.reports).toHaveLength(0);
		});

		test("non-[gone] merged branch with dirty worktree — skipped-dirty, worktree preserved", async () => {
			const git = createFakeGit({
				worktrees: [mainWt, featureA],
				branches: ["main", "feature-a"],
				goneBranches: [],
				mergedBranches: ["feature-a"],
				commitCountMap: new Map([["main..feature-a", 2]]),
				revListMap: new Map([["main..feature-a", ["sha1", "sha2"]]]),
				revListCherryPickMap: new Map([["main...feature-a", []]]),
				dirtyWorktrees: new Set(["/wt/feature-a"]),
			});
			const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

			expect(output.reports).toHaveLength(1);
			expect(output.reports[0]).toMatchObject({
				branch: "feature-a",
				worktreePath: "/wt/feature-a",
				result: { status: "skipped-dirty" },
			});
			const remaining = await git.listWorktrees();
			expect(remaining.success && remaining.data.some((w) => w.path === "/wt/feature-a")).toBe(true);
		});

		test("non-[gone] merged branch with dirty worktree + --force — cleaned", async () => {
			const git = createFakeGit({
				worktrees: [mainWt, featureA],
				branches: ["main", "feature-a"],
				goneBranches: [],
				mergedBranches: ["feature-a"],
				commitCountMap: new Map([["main..feature-a", 2]]),
				revListMap: new Map([["main..feature-a", ["sha1", "sha2"]]]),
				revListCherryPickMap: new Map([["main...feature-a", []]]),
				dirtyWorktrees: new Set(["/wt/feature-a"]),
			});
			const output = expectOk(await cleanupWorktrees({ force: true, dryRun: false }, { git }));

			expect(output.reports).toHaveLength(1);
			expect(output.reports[0]).toMatchObject({
				branch: "feature-a",
				result: { status: "cleaned" },
			});
		});

		test("non-[gone] merged branch with worktree — dry-run reports candidate", async () => {
			const git = createFakeGit({
				worktrees: [mainWt, featureA],
				branches: ["main", "feature-a"],
				goneBranches: [],
				mergedBranches: ["feature-a"],
				commitCountMap: new Map([["main..feature-a", 2]]),
				revListMap: new Map([["main..feature-a", ["sha1", "sha2"]]]),
				revListCherryPickMap: new Map([["main...feature-a", []]]),
			});
			const output = expectOk(await cleanupWorktrees({ force: false, dryRun: true }, { git }));

			expect(output.reports).toHaveLength(1);
			expect(output.reports[0]).toMatchObject({
				branch: "feature-a",
				worktreePath: "/wt/feature-a",
				result: { status: "dry-run" },
			});
			// Worktree NOT removed.
			const remaining = await git.listWorktrees();
			expect(remaining.success && remaining.data.some((w) => w.path === "/wt/feature-a")).toBe(true);
		});

		test("[gone] merged + non-[gone] merged in same run — both cleaned, no duplicates", async () => {
			const git = createFakeGit({
				worktrees: [mainWt, featureA, featureB],
				branches: ["main", "feature-a", "feature-b"],
				goneBranches: ["feature-a"],
				mergedBranches: ["feature-a", "feature-b"],
				commitCountMap: new Map([
					["main..feature-a", 0],
					["main..feature-b", 2],
				]),
				revListMap: new Map([["main..feature-b", ["sha1", "sha2"]]]),
				revListCherryPickMap: new Map([["main...feature-b", []]]),
			});
			const output = expectOk(await cleanupWorktrees({ force: false, dryRun: false }, { git }));

			const featureAReport = output.reports.find((r) => r.branch === "feature-a");
			const featureBReport = output.reports.find((r) => r.branch === "feature-b");
			expect(featureAReport).toMatchObject({ result: { status: "cleaned" } });
			expect(featureBReport).toMatchObject({ result: { status: "cleaned" } });
			// Each branch appears exactly once.
			expect(output.reports.filter((r) => r.branch === "feature-a")).toHaveLength(1);
			expect(output.reports.filter((r) => r.branch === "feature-b")).toHaveLength(1);
		});
	});
});
