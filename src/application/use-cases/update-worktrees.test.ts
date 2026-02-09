import { describe, expect, test } from "bun:test";
import type { Worktree } from "../../domain/entities/worktree.ts";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { updateWorktrees } from "./update-worktrees.ts";

const mainWt: Worktree = { path: "/repo", branch: "main", head: "aaa", isMain: true };
const featureA: Worktree = { path: "/repo-a", branch: "feature-a", head: "bbb", isMain: false };
const featureB: Worktree = { path: "/repo-b", branch: "feature-b", head: "ccc", isMain: false };

function flatBranchesConfig(worktrees: Worktree[]) {
	const nonDefault = worktrees.filter((w) => w.branch && w.branch !== "main");
	const mergeBaseMap = new Map<string, string>();
	const commitCountMap = new Map<string, number>();

	for (const wt of nonDefault) {
		mergeBaseMap.set(`${wt.branch}:main`, "aaa");
		mergeBaseMap.set(`main:${wt.branch}`, "aaa");
		commitCountMap.set(`aaa..${wt.branch}`, 2);

		for (const other of nonDefault) {
			if (other.branch === wt.branch) continue;
			mergeBaseMap.set(`${wt.branch}:${other.branch}`, "aaa");
			commitCountMap.set(`aaa..${other.branch}`, 2);
		}
	}

	return { mergeBaseMap, commitCountMap };
}

describe("updateWorktrees", () => {
	test("happy path: fetch + ff + rebase all feature branches", async () => {
		const worktrees = [mainWt, featureA, featureB];
		const git = createFakeGit({ worktrees, ...flatBranchesConfig(worktrees) });
		const result = await updateWorktrees({ dryRun: false }, { git });

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
		const result = await updateWorktrees({ dryRun: false }, { git });

		const output = expectOk(result);
		expect(output.defaultBranchUpdate).toBe("ref-updated");
	});

	test("fetch failure — returns error", async () => {
		const git = createFakeGit({ worktrees: [mainWt], fetchFails: true });
		const result = await updateWorktrees({ dryRun: false }, { git });

		const error = expectErr(result);
		expect(error.message).toContain("Fetch failed");
	});

	test("ff-only failure — returns error, no rebase", async () => {
		const git = createFakeGit({ worktrees: [mainWt, featureA], mergeFFOnlyFails: true });
		const result = await updateWorktrees({ dryRun: false }, { git });

		const error = expectErr(result);
		expect(error.message).toContain("Failed to fast-forward");
	});

	test("dirty worktree — rebased via WIP commit", async () => {
		const worktrees = [mainWt, featureA, featureB];
		const git = createFakeGit({
			worktrees,
			dirtyWorktrees: new Set(["/repo-a"]),
			...flatBranchesConfig(worktrees),
		});
		const result = await updateWorktrees({ dryRun: false }, { git });

		const output = expectOk(result);
		expect(output.reports[1]).toMatchObject({ branch: "feature-a", result: { status: "rebased-dirty" } });
		expect(output.reports[2]).toMatchObject({ branch: "feature-b", result: { status: "rebased" } });
	});

	test("dirty worktree + rebase conflict — abort and restore", async () => {
		const worktrees = [mainWt, featureA, featureB];
		const git = createFakeGit({
			worktrees,
			dirtyWorktrees: new Set(["/repo-a"]),
			rebaseConflicts: new Set(["/repo-a"]),
			...flatBranchesConfig(worktrees),
		});
		const result = await updateWorktrees({ dryRun: false }, { git });

		const output = expectOk(result);
		expect(output.reports[1]).toMatchObject({ branch: "feature-a", result: { status: "rebase-conflict" } });
		expect(output.reports[2]).toMatchObject({ branch: "feature-b", result: { status: "rebased" } });
	});

	test("rebase conflict — abort and continue", async () => {
		const worktrees = [mainWt, featureA, featureB];
		const git = createFakeGit({
			worktrees,
			rebaseConflicts: new Set(["/repo-a"]),
			...flatBranchesConfig(worktrees),
		});
		const result = await updateWorktrees({ dryRun: false }, { git });

		const output = expectOk(result);
		expect(output.reports[1]).toMatchObject({ branch: "feature-a", result: { status: "rebase-conflict" } });
		expect(output.reports[2]).toMatchObject({ branch: "feature-b", result: { status: "rebased" } });
	});

	test("dry-run — reports what would be done", async () => {
		const worktrees = [mainWt, featureA, featureB];
		const git = createFakeGit({ worktrees, ...flatBranchesConfig(worktrees) });
		const result = await updateWorktrees({ dryRun: true }, { git });

		const output = expectOk(result);
		expect(output.reports[0]).toMatchObject({ branch: "main", result: { status: "is-default-branch" } });
		expect(output.reports[1]).toMatchObject({ branch: "feature-a", result: { status: "dry-run", dirty: false } });
		expect(output.reports[2]).toMatchObject({ branch: "feature-b", result: { status: "dry-run", dirty: false } });
	});

	test("dry-run — marks dirty worktrees", async () => {
		const worktrees = [mainWt, featureA, featureB];
		const git = createFakeGit({
			worktrees,
			dirtyWorktrees: new Set(["/repo-a"]),
			...flatBranchesConfig(worktrees),
		});
		const result = await updateWorktrees({ dryRun: true }, { git });

		const output = expectOk(result);
		expect(output.reports[1]).toMatchObject({ branch: "feature-a", result: { status: "dry-run", dirty: true } });
		expect(output.reports[2]).toMatchObject({ branch: "feature-b", result: { status: "dry-run", dirty: false } });
	});

	test("detached HEAD worktree — silently skipped", async () => {
		const detached: Worktree = { path: "/repo-detached", branch: "", head: "ddd", isMain: false };
		const git = createFakeGit({ worktrees: [mainWt, detached, featureA] });
		const result = await updateWorktrees({ dryRun: false }, { git });

		const output = expectOk(result);
		expect(output.reports).toHaveLength(2);
		expect(output.reports[0]).toMatchObject({ branch: "main", result: { status: "is-default-branch" } });
		expect(output.reports[1]).toMatchObject({ branch: "feature-a", result: { status: "rebased" } });
	});
});

describe("updateWorktrees — parent detection", () => {
	// main: A — B — C
	// feat-a:        C — D — E
	// feat-sub:              E — F — G
	function chainConfig() {
		const main: Worktree = { path: "/repo", branch: "main", head: "aaa", isMain: true };
		const featA: Worktree = { path: "/repo-a", branch: "feat-a", head: "eee", isMain: false };
		const featSub: Worktree = { path: "/repo-sub", branch: "feat-sub", head: "ggg", isMain: false };

		const mergeBaseMap = new Map([
			["feat-a:main", "aaa"],
			["feat-a:feat-sub", "eee"],
			["feat-sub:main", "aaa"],
			["feat-sub:feat-a", "eee"],
			["main:feat-a", "aaa"],
			["main:feat-sub", "aaa"],
		]);

		const commitCountMap = new Map([
			["aaa..feat-a", 2],
			["aaa..feat-sub", 4],
			["eee..feat-sub", 2],
			["eee..feat-a", 0],
		]);

		return { worktrees: [main, featA, featSub], mergeBaseMap, commitCountMap };
	}

	test("chain: feat-sub rebases onto feat-a, not main", async () => {
		const { worktrees, mergeBaseMap, commitCountMap } = chainConfig();
		const git = createFakeGit({ worktrees, mergeBaseMap, commitCountMap });
		const result = await updateWorktrees({ dryRun: false }, { git });

		const output = expectOk(result);
		expect(output.reports).toHaveLength(3);
		expect(output.reports[0]).toMatchObject({ branch: "main", result: { status: "is-default-branch" } });
		expect(output.reports[1]).toMatchObject({
			branch: "feat-a",
			parent: "main",
			result: { status: "rebased" },
		});
		expect(output.reports[2]).toMatchObject({
			branch: "feat-sub",
			parent: "feat-a",
			result: { status: "rebased" },
		});
	});

	test("chain: parent conflict → child skipped", async () => {
		const { worktrees, mergeBaseMap, commitCountMap } = chainConfig();
		const git = createFakeGit({
			worktrees,
			mergeBaseMap,
			commitCountMap,
			rebaseConflicts: new Set(["/repo-a"]),
		});
		const result = await updateWorktrees({ dryRun: false }, { git });

		const output = expectOk(result);
		expect(output.reports[1]).toMatchObject({
			branch: "feat-a",
			parent: "main",
			result: { status: "rebase-conflict" },
		});
		expect(output.reports[2]).toMatchObject({
			branch: "feat-sub",
			parent: "feat-a",
			result: { status: "skipped", reason: "parent feat-a failed" },
		});
	});

	test("chain: dry-run shows correct parents", async () => {
		const { worktrees, mergeBaseMap, commitCountMap } = chainConfig();
		const git = createFakeGit({ worktrees, mergeBaseMap, commitCountMap });
		const result = await updateWorktrees({ dryRun: true }, { git });

		const output = expectOk(result);
		expect(output.reports[1]).toMatchObject({
			branch: "feat-a",
			parent: "main",
			result: { status: "dry-run", dirty: false },
		});
		expect(output.reports[2]).toMatchObject({
			branch: "feat-sub",
			parent: "feat-a",
			result: { status: "dry-run", dirty: false },
		});
	});

	test("no merge-base data — falls back to defaultBranch", async () => {
		const git = createFakeGit({ worktrees: [mainWt, featureA, featureB] });
		const result = await updateWorktrees({ dryRun: false }, { git });

		const output = expectOk(result);
		expect(output.reports[1]).toMatchObject({
			branch: "feature-a",
			parent: "main",
			result: { status: "rebased" },
		});
		expect(output.reports[2]).toMatchObject({
			branch: "feature-b",
			parent: "main",
			result: { status: "rebased" },
		});
	});
});
