import { describe, expect, test } from "bun:test";
import type { Worktree } from "../../domain/entities/worktree.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createFakeGit, type FakeRebaseCall } from "../../test-utils/fake-git.ts";
import { createFakeShell } from "../../test-utils/fake-shell.ts";
import { updateWorktrees } from "./update-worktrees.ts";

/**
 * Wraps a fake git so every `rebase` records a start/end event and a peak
 * concurrency counter. A small real delay forces overlapping rebases to actually
 * overlap in time, so the scheduler's ordering and bounding are observable.
 */
interface RebaseTracker {
	events: { path: string; phase: "start" | "end" }[];
	startOrder: string[];
	peak: number;
}

function instrumentRebase(git: GitPort, delayMs = 15): { git: GitPort; tracker: RebaseTracker } {
	const tracker: RebaseTracker = { events: [], startOrder: [], peak: 0 };
	let active = 0;
	const baseRebase = git.rebase.bind(git);
	const wrapped: GitPort = {
		...git,
		async rebase(path, onto, opts) {
			active += 1;
			tracker.peak = Math.max(tracker.peak, active);
			tracker.events.push({ path, phase: "start" });
			tracker.startOrder.push(path);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			const result = await baseRebase(path, onto, opts);
			tracker.events.push({ path, phase: "end" });
			active -= 1;
			return result;
		},
	};
	return { git: wrapped, tracker };
}

const mainWt: Worktree = { path: "/repo", branch: "main", head: "aaa", isMain: true, isPrunable: false };
const featureA: Worktree = { path: "/repo-a", branch: "feature-a", head: "bbb", isMain: false, isPrunable: false };
const featureB: Worktree = { path: "/repo-b", branch: "feature-b", head: "ccc", isMain: false, isPrunable: false };

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

	test("genuine default-branch divergence — non-fatal skip, feature branches still rebase (R2, R4)", async () => {
		// A diverged default branch whose local commits are NOT all upstream (mergeFFOnly
		// fails + findMergedPrefix does not report "fully") must no longer abort the run.
		const worktrees = [mainWt, featureA];
		const base = flatBranchesConfig(worktrees);
		base.commitCountMap.set("origin/main..main", 2);
		const resetHardToRemoteCalls: { worktreePath: string; branch: string; remote: string }[] = [];
		const forceUpdateBranchRefCalls: { branch: string; remote: string }[] = [];
		const git = createFakeGit({
			worktrees,
			mergeFFOnlyFails: true,
			resetHardToRemoteCalls,
			forceUpdateBranchRefCalls,
			revListMap: new Map([["origin/main..main", ["c2", "c1"]]]),
			revListCherryPickMap: new Map([["origin/main...main", ["c2", "c1"]]]),
			...base,
		});

		const result = await updateWorktrees({ dryRun: false }, { git });

		// R4: the run does not abort — it resolves ok, not err.
		const output = expectOk(result);
		expect(output.defaultBranchUpdate).toBe("skipped-diverged");
		// R2: no reset primitive is called for a genuine divergence.
		expect(resetHardToRemoteCalls).toEqual([]);
		expect(forceUpdateBranchRefCalls).toEqual([]);
		// R4: every feature worktree still has a report — the run rebased them.
		expect(output.reports.find((r) => r.branch === "feature-a")?.result.status).toBe("rebased");
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

	test("WIP restore failure after successful rebase — rebased-dirty with warning", async () => {
		const worktrees = [mainWt, featureA, featureB];
		const git = createFakeGit({
			worktrees,
			dirtyWorktrees: new Set(["/repo-a"]),
			resetLastCommitFail: { code: "UNKNOWN", message: "reset failed" },
			...flatBranchesConfig(worktrees),
		});
		const result = await updateWorktrees({ dryRun: false }, { git });

		const output = expectOk(result);
		expect(output.reports[1]).toMatchObject({ branch: "feature-a", result: { status: "rebased-dirty" } });
		expect(output.reports[1]?.result).toHaveProperty("warning");
		expect((output.reports[1]?.result as { warning?: string }).warning).toContain("WIP commit");
		expect(output.reports[2]).toMatchObject({ branch: "feature-b", result: { status: "rebased" } });
		expect((output.reports[2]?.result as { warning?: string }).warning).toBeUndefined();
	});

	test("rebase abort failure on conflict — conflict report carries warning", async () => {
		const worktrees = [mainWt, featureA, featureB];
		const git = createFakeGit({
			worktrees,
			rebaseConflicts: new Set(["/repo-a"]),
			rebaseAbortFail: { code: "UNKNOWN", message: "abort failed" },
			...flatBranchesConfig(worktrees),
		});
		const result = await updateWorktrees({ dryRun: false }, { git });

		const output = expectOk(result);
		expect(output.reports[1]).toMatchObject({ branch: "feature-a", result: { status: "rebase-conflict" } });
		expect((output.reports[1]?.result as { warning?: string }).warning).toContain("mid-rebase");
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
		const detached: Worktree = { path: "/repo-detached", branch: "", head: "ddd", isMain: false, isPrunable: false };
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
		const main: Worktree = { path: "/repo", branch: "main", head: "aaa", isMain: true, isPrunable: false };
		const featA: Worktree = { path: "/repo-a", branch: "feat-a", head: "eee", isMain: false, isPrunable: false };
		const featSub: Worktree = { path: "/repo-sub", branch: "feat-sub", head: "ggg", isMain: false, isPrunable: false };

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

describe("updateWorktrees — gone parent retargeting", () => {
	test("stacked branch whose parent has a gone remote — retargets to main and flags it", async () => {
		const git = createFakeGit({
			worktrees: [mainWt, featureA, featureB],
			goneBranches: ["feature-a"],
			mergeBaseMap: new Map([
				["feature-b:main", "MB_BM"],
				["main:feature-b", "MB_BM"],
				["feature-b:feature-a", "MB_BA"],
				["feature-a:feature-b", "MB_BA"],
				["feature-a:main", "MB_AM"],
				["main:feature-a", "MB_AM"],
			]),
			commitCountMap: new Map([
				["MB_BM..feature-b", 5],
				["MB_BA..feature-b", 2],
				["MB_AM..feature-a", 3],
				["MB_BA..feature-a", 0],
			]),
		});

		const result = await updateWorktrees({ dryRun: false }, { git });
		const output = expectOk(result);

		const reportA = output.reports.find((r) => r.branch === "feature-a");
		expect(reportA?.retargetedFrom).toBeUndefined();

		const reportB = output.reports.find((r) => r.branch === "feature-b");
		expect(reportB).toMatchObject({
			parent: "main",
			retargetedFrom: "feature-a",
			result: { status: "rebased" },
		});
	});

	test("A→B→C with gone middle B — C retargets to nearest live ancestor A", async () => {
		const featureC: Worktree = { path: "/repo-c", branch: "feature-c", head: "ddd", isMain: false, isPrunable: false };
		const git = createFakeGit({
			worktrees: [mainWt, featureA, featureB, featureC],
			goneBranches: ["feature-b"],
			mergeBaseMap: new Map([
				["feature-c:main", "MB_CM"],
				["main:feature-c", "MB_CM"],
				["feature-c:feature-a", "MB_CA"],
				["feature-a:feature-c", "MB_CA"],
				["feature-c:feature-b", "MB_CB"],
				["feature-b:feature-c", "MB_CB"],
				["feature-b:main", "MB_BM"],
				["main:feature-b", "MB_BM"],
				["feature-b:feature-a", "MB_BA"],
				["feature-a:feature-b", "MB_BA"],
				["feature-a:main", "MB_AM"],
				["main:feature-a", "MB_AM"],
			]),
			commitCountMap: new Map([
				["MB_CM..feature-c", 6],
				["MB_CA..feature-c", 4],
				["MB_CB..feature-c", 2],
				["MB_BM..feature-b", 4],
				["MB_BA..feature-b", 2],
				["MB_CB..feature-b", 0],
				["MB_AM..feature-a", 2],
				["MB_BA..feature-a", 0],
				["MB_CA..feature-a", 0],
			]),
		});

		const result = await updateWorktrees({ dryRun: false }, { git });
		const output = expectOk(result);

		const reportC = output.reports.find((r) => r.branch === "feature-c");
		expect(reportC).toMatchObject({
			parent: "feature-a",
			retargetedFrom: "feature-b",
			result: { status: "rebased" },
		});
	});
});

describe("updateWorktrees — already-merged prefix detection", () => {
	test("stacked branch with squash-merged parent rebases via --onto <parent> <lastSkipped>", async () => {
		// feature-a was squash-merged into main (worktree removed by cleanup).
		// feature-b is stacked on feature-a; without prefix detection, plain rebase onto main
		// would replay feature-a's commits and conflict with the squash.
		const main: Worktree = { path: "/repo", branch: "main", head: "M2", isMain: true, isPrunable: false };
		const featB: Worktree = { path: "/repo-b", branch: "feature-b", head: "fb2", isMain: false, isPrunable: false };

		// rev-list main..feature-b is reverse-chronological:
		// [fb2, fb1, fa2, fa1] — fa1 and fa2 are the (now-squashed) feature-a commits
		const mergeBaseMap = new Map([
			["feature-b:main", "M0"],
			["main:feature-b", "M0"],
		]);

		const commitCountMap = new Map([["M0..feature-b", 4]]);

		const rebaseCalls: FakeRebaseCall[] = [];

		const git = createFakeGit({
			worktrees: [main, featB],
			mergeBaseMap,
			commitCountMap,
			rebaseCalls,
			revListMap: new Map([
				["main..feature-b", ["fb2", "fb1", "fa2", "fa1"]],
				["feature-b..main", ["S"]],
			]),
			revListCherryPickMap: new Map([["main...feature-b", ["fb2", "fb1", "fa2", "fa1"]]]),
			logSubjectsMap: new Map([
				[
					"main..feature-b",
					[
						{ sha: "fb2", subject: "feat-b 2" },
						{ sha: "fb1", subject: "feat-b 1" },
						{ sha: "fa2", subject: "feat-a 2" },
						{ sha: "fa1", subject: "feat-a 1" },
					],
				],
				["feature-b..main", [{ sha: "S", subject: "feat-a (squashed)" }]],
			]),
			diffTreeFilesMap: new Map([
				["fa1", ["a1.ts"]],
				["fa2", ["a2.ts"]],
				["fb1", ["b1.ts"]],
				["fb2", ["b2.ts"]],
				["S", ["a1.ts", "a2.ts"]],
			]),
			diffNormalizedMap: new Map([
				["M0..fa2", "DIFF_A"],
				["S^..S", "DIFF_A"],
			]),
		});

		const result = await updateWorktrees({ dryRun: false }, { git });

		const output = expectOk(result);
		const featureBReport = output.reports.find((r) => r.branch === "feature-b");
		expect(featureBReport?.result).toMatchObject({ status: "rebased" });

		const featureBRebase = rebaseCalls.find((c) => c.worktreePath === "/repo-b");
		expect(featureBRebase).toBeDefined();
		expect(featureBRebase?.onto).toBe("main");
		expect(featureBRebase?.opts).toEqual({ upstream: "fa2", branch: "feature-b" });
	});

	test("fully squash-merged branch — skipped without rebase", async () => {
		const main: Worktree = { path: "/repo", branch: "main", head: "M2", isMain: true, isPrunable: false };
		const featA: Worktree = { path: "/repo-a", branch: "feature-a", head: "f2", isMain: false, isPrunable: false };

		const mergeBaseMap = new Map([
			["feature-a:main", "M0"],
			["main:feature-a", "M0"],
		]);
		const commitCountMap = new Map([["M0..feature-a", 2]]);

		const rebaseCalls: FakeRebaseCall[] = [];

		const git = createFakeGit({
			worktrees: [main, featA],
			mergeBaseMap,
			commitCountMap,
			rebaseCalls,
			revListMap: new Map([
				["main..feature-a", ["f2", "f1"]],
				["feature-a..main", ["S"]],
			]),
			revListCherryPickMap: new Map([["main...feature-a", ["f2", "f1"]]]),
			logSubjectsMap: new Map([
				[
					"main..feature-a",
					[
						{ sha: "f2", subject: "feat: B" },
						{ sha: "f1", subject: "feat: A" },
					],
				],
				["feature-a..main", [{ sha: "S", subject: "feat: squash" }]],
			]),
			diffTreeFilesMap: new Map([
				["f1", ["a.ts"]],
				["f2", ["b.ts"]],
				["S", ["a.ts", "b.ts"]],
			]),
			diffNormalizedMap: new Map([
				["M0..f2", "DIFF_AB"],
				["S^..S", "DIFF_AB"],
			]),
		});

		const result = await updateWorktrees({ dryRun: false }, { git });

		const output = expectOk(result);
		const featReport = output.reports.find((r) => r.branch === "feature-a");
		expect(featReport?.result).toMatchObject({ status: "skipped", reason: "fully merged" });
		expect(rebaseCalls.find((c) => c.worktreePath === "/repo-a")).toBeUndefined();
	});

	test("fully cherry-picked branch — skipped without rebase", async () => {
		const main: Worktree = { path: "/repo", branch: "main", head: "M", isMain: true, isPrunable: false };
		const featA: Worktree = { path: "/repo-a", branch: "feature-a", head: "f2", isMain: false, isPrunable: false };

		const mergeBaseMap = new Map([
			["feature-a:main", "M"],
			["main:feature-a", "M"],
		]);
		const commitCountMap = new Map([["M..feature-a", 2]]);

		const rebaseCalls: FakeRebaseCall[] = [];

		const git = createFakeGit({
			worktrees: [main, featA],
			mergeBaseMap,
			commitCountMap,
			rebaseCalls,
			revListMap: new Map([["main..feature-a", ["f2", "f1"]]]),
			revListCherryPickMap: new Map([["main...feature-a", []]]),
			logSubjectsMap: new Map([
				[
					"main..feature-a",
					[
						{ sha: "f2", subject: "feat: B" },
						{ sha: "f1", subject: "feat: A" },
					],
				],
				["feature-a..main", []],
			]),
			diffTreeFilesMap: new Map([
				["f1", ["a.ts"]],
				["f2", ["b.ts"]],
			]),
		});

		const result = await updateWorktrees({ dryRun: false }, { git });

		const output = expectOk(result);
		const featReport = output.reports.find((r) => r.branch === "feature-a");
		expect(featReport?.result).toMatchObject({ status: "skipped", reason: "fully merged" });
		expect(rebaseCalls.find((c) => c.worktreePath === "/repo-a")).toBeUndefined();
	});

	test("partially squash-merged branch — still rebases with --upstream (AC#2 regression)", async () => {
		// feature-b has 4 commits; fa1 and fa2 are squashed into S on main, fb1/fb2 remain.
		// Partial merge: prefix detected with skippedCount=2 < totalCount=4 → rebase --onto with upstream.
		const main: Worktree = { path: "/repo", branch: "main", head: "M2", isMain: true, isPrunable: false };
		const featB: Worktree = { path: "/repo-b", branch: "feature-b", head: "fb2", isMain: false, isPrunable: false };

		const mergeBaseMap = new Map([
			["feature-b:main", "M0"],
			["main:feature-b", "M0"],
		]);
		const commitCountMap = new Map([["M0..feature-b", 4]]);

		const rebaseCalls: FakeRebaseCall[] = [];

		const git = createFakeGit({
			worktrees: [main, featB],
			mergeBaseMap,
			commitCountMap,
			rebaseCalls,
			revListMap: new Map([
				["main..feature-b", ["fb2", "fb1", "fa2", "fa1"]],
				["feature-b..main", ["S"]],
			]),
			revListCherryPickMap: new Map([["main...feature-b", ["fb2", "fb1", "fa2", "fa1"]]]),
			logSubjectsMap: new Map([
				[
					"main..feature-b",
					[
						{ sha: "fb2", subject: "feat-b 2" },
						{ sha: "fb1", subject: "feat-b 1" },
						{ sha: "fa2", subject: "feat-a 2" },
						{ sha: "fa1", subject: "feat-a 1" },
					],
				],
				["feature-b..main", [{ sha: "S", subject: "feat-a (squashed)" }]],
			]),
			diffTreeFilesMap: new Map([
				["fa1", ["a1.ts"]],
				["fa2", ["a2.ts"]],
				["fb1", ["b1.ts"]],
				["fb2", ["b2.ts"]],
				["S", ["a1.ts", "a2.ts"]],
			]),
			diffNormalizedMap: new Map([
				["M0..fa2", "DIFF_A"],
				["S^..S", "DIFF_A"],
			]),
		});

		const result = await updateWorktrees({ dryRun: false }, { git });

		const output = expectOk(result);
		const featBReport = output.reports.find((r) => r.branch === "feature-b");
		expect(featBReport?.result).toMatchObject({ status: "rebased" });
		const call = rebaseCalls.find((c) => c.worktreePath === "/repo-b");
		expect(call?.opts).toEqual({ upstream: "fa2", branch: "feature-b" });
	});

	test("no prefix detected → plain rebase (no regression)", async () => {
		const main: Worktree = { path: "/repo", branch: "main", head: "M", isMain: true, isPrunable: false };
		const featA: Worktree = { path: "/repo-a", branch: "feature-a", head: "fa", isMain: false, isPrunable: false };

		const mergeBaseMap = new Map([
			["feature-a:main", "M"],
			["main:feature-a", "M"],
		]);
		const commitCountMap = new Map([["M..feature-a", 1]]);

		const rebaseCalls: FakeRebaseCall[] = [];

		const git = createFakeGit({
			worktrees: [main, featA],
			mergeBaseMap,
			commitCountMap,
			rebaseCalls,
			revListMap: new Map([
				["main..feature-a", ["fa"]],
				["feature-a..main", []],
			]),
			revListCherryPickMap: new Map([["main...feature-a", ["fa"]]]),
			logSubjectsMap: new Map([
				["main..feature-a", [{ sha: "fa", subject: "new" }]],
				["feature-a..main", []],
			]),
			diffTreeFilesMap: new Map([["fa", ["a.ts"]]]),
		});

		const result = await updateWorktrees({ dryRun: false }, { git });

		expectOk(result);
		const featureARebase = rebaseCalls.find((c) => c.worktreePath === "/repo-a");
		expect(featureARebase).toBeDefined();
		expect(featureARebase?.opts).toBeUndefined();
		expect(featureARebase?.onto).toBe("main");
	});
});

describe("updateWorktrees — fresh branch (zero commits from default)", () => {
	test("fresh branch with no own commits — parent is defaultBranch, not another worktree", async () => {
		const main: Worktree = { path: "/repo", branch: "main", head: "aaa", isMain: true, isPrunable: false };
		const featA: Worktree = { path: "/repo-a", branch: "feat-a", head: "ddd", isMain: false, isPrunable: false };
		const fresh: Worktree = { path: "/repo-fresh", branch: "fresh", head: "aaa", isMain: false, isPrunable: false };

		const mergeBaseMap = new Map([
			["fresh:main", "aaa"],
			["fresh:feat-a", "bbb"],
			["feat-a:main", "aaa"],
			["feat-a:fresh", "aaa"],
			["main:feat-a", "aaa"],
			["main:fresh", "aaa"],
		]);

		const commitCountMap = new Map([
			["aaa..fresh", 0],
			["bbb..fresh", 17],
			["aaa..feat-a", 3],
		]);

		const git = createFakeGit({ worktrees: [main, featA, fresh], mergeBaseMap, commitCountMap });
		const result = await updateWorktrees({ dryRun: true }, { git });

		const output = expectOk(result);
		const freshReport = output.reports.find((r) => r.branch === "fresh");
		expect(freshReport).toBeDefined();
		expect(freshReport?.parent).toBe("main");
	});
});

describe("updateWorktrees — no main worktree", () => {
	test("multiple flat features without main worktree — all rebased onto default branch", async () => {
		const worktrees = [featureA, featureB];
		const git = createFakeGit({ worktrees, ...flatBranchesConfig(worktrees) });
		const result = await updateWorktrees({ dryRun: false }, { git });

		const output = expectOk(result);
		expect(output.defaultBranchUpdate).toBe("ref-updated");
		expect(output.reports).toHaveLength(2);
		expect(output.reports[0]).toMatchObject({ branch: "feature-a", parent: "main", result: { status: "rebased" } });
		expect(output.reports[1]).toMatchObject({ branch: "feature-b", parent: "main", result: { status: "rebased" } });
	});

	test("chain without main worktree — correct parent detection", async () => {
		const featA: Worktree = { path: "/repo-a", branch: "feat-a", head: "eee", isMain: false, isPrunable: false };
		const featSub: Worktree = { path: "/repo-sub", branch: "feat-sub", head: "ggg", isMain: false, isPrunable: false };

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

		const git = createFakeGit({ worktrees: [featA, featSub], mergeBaseMap, commitCountMap });
		const result = await updateWorktrees({ dryRun: false }, { git });

		const output = expectOk(result);
		expect(output.defaultBranchUpdate).toBe("ref-updated");
		expect(output.reports).toHaveLength(2);
		expect(output.reports[0]).toMatchObject({ branch: "feat-a", parent: "main", result: { status: "rebased" } });
		expect(output.reports[1]).toMatchObject({ branch: "feat-sub", parent: "feat-a", result: { status: "rebased" } });
	});
});

describe("updateWorktrees — branch filter", () => {
	function chainWithSiblingConfig() {
		const main: Worktree = { path: "/repo", branch: "main", head: "aaa", isMain: true, isPrunable: false };
		const featA: Worktree = { path: "/repo-a", branch: "feat-a", head: "eee", isMain: false, isPrunable: false };
		const featSub: Worktree = { path: "/repo-sub", branch: "feat-sub", head: "ggg", isMain: false, isPrunable: false };
		const featB: Worktree = { path: "/repo-b", branch: "feat-b", head: "hhh", isMain: false, isPrunable: false };

		const mergeBaseMap = new Map([
			["feat-a:main", "aaa"],
			["feat-a:feat-sub", "eee"],
			["feat-a:feat-b", "aaa"],
			["feat-sub:main", "aaa"],
			["feat-sub:feat-a", "eee"],
			["feat-sub:feat-b", "aaa"],
			["feat-b:main", "aaa"],
			["feat-b:feat-a", "aaa"],
			["feat-b:feat-sub", "aaa"],
			["main:feat-a", "aaa"],
			["main:feat-sub", "aaa"],
			["main:feat-b", "aaa"],
		]);

		const commitCountMap = new Map([
			["aaa..feat-a", 2],
			["aaa..feat-sub", 4],
			["aaa..feat-b", 3],
			["eee..feat-sub", 2],
			["eee..feat-a", 0],
		]);

		return { worktrees: [main, featA, featSub, featB], mergeBaseMap, commitCountMap };
	}

	test("branch filter: update feat-a updates feat-a + feat-sub, skips feat-b", async () => {
		const { worktrees, mergeBaseMap, commitCountMap } = chainWithSiblingConfig();
		const git = createFakeGit({ worktrees, mergeBaseMap, commitCountMap });
		const result = await updateWorktrees({ dryRun: false, branch: "feat-a" }, { git });

		const output = expectOk(result);
		const branches = output.reports.map((r) => r.branch);
		expect(branches).toContain("main");
		expect(branches).toContain("feat-a");
		expect(branches).toContain("feat-sub");
		expect(branches).not.toContain("feat-b");
	});

	test("branch filter: update leaf branch updates only that branch", async () => {
		const { worktrees, mergeBaseMap, commitCountMap } = chainWithSiblingConfig();
		const git = createFakeGit({ worktrees, mergeBaseMap, commitCountMap });
		const result = await updateWorktrees({ dryRun: false, branch: "feat-sub" }, { git });

		const output = expectOk(result);
		const branches = output.reports.map((r) => r.branch);
		expect(branches).toContain("main");
		expect(branches).toContain("feat-sub");
		expect(branches).not.toContain("feat-a");
		expect(branches).not.toContain("feat-b");
	});

	test("branch filter: nonexistent branch returns error", async () => {
		const { worktrees, mergeBaseMap, commitCountMap } = chainWithSiblingConfig();
		const git = createFakeGit({ worktrees, mergeBaseMap, commitCountMap });
		const result = await updateWorktrees({ dryRun: false, branch: "nonexistent" }, { git });

		const error = expectErr(result);
		expect(error.message).toContain("nonexistent");
		expect(error.message).toContain("not found");
	});
});

describe("updateWorktrees — post-update hooks", () => {
	test("runs hooks for each successfully rebased branch", async () => {
		const worktrees = [mainWt, featureA, featureB];
		const git = createFakeGit({ worktrees, ...flatBranchesConfig(worktrees) });
		const shell = createFakeShell();

		const result = await updateWorktrees(
			{ dryRun: false, postUpdateHooks: ["git push --force-with-lease"], repoRoot: "/repo" },
			{ git, shell },
		);

		const output = expectOk(result);
		expect(shell.calls).toHaveLength(2);
		expect(shell.calls[0]?.command).toBe("git push --force-with-lease");
		expect(shell.calls[0]?.options.cwd).toBe("/repo-a");
		expect(shell.calls[0]?.options.env).toMatchObject({
			WORKTREE_BRANCH: "feature-a",
			WORKTREE_PATH: "/repo-a",
			REPO_ROOT: "/repo",
		});
		expect(shell.calls[1]?.options.cwd).toBe("/repo-b");
		const featureAReport = output.reports.find((r) => r.branch === "feature-a");
		const featureBReport = output.reports.find((r) => r.branch === "feature-b");
		expect(featureAReport?.hookNotifications).toHaveLength(1);
		expect(featureAReport?.hookNotifications[0]?.level).toBe("info");
		expect(featureBReport?.hookNotifications).toHaveLength(1);
		expect(featureBReport?.hookNotifications[0]?.level).toBe("info");
	});

	test("does not run hooks for conflicted or skipped branches", async () => {
		const worktrees = [mainWt, featureA, featureB];
		const git = createFakeGit({
			worktrees,
			rebaseConflicts: new Set(["/repo-a"]),
			...flatBranchesConfig(worktrees),
		});
		const shell = createFakeShell();

		const result = await updateWorktrees(
			{ dryRun: false, postUpdateHooks: ["echo done"], repoRoot: "/repo" },
			{ git, shell },
		);

		const output = expectOk(result);
		expect(shell.calls).toHaveLength(1);
		expect(shell.calls[0]?.options.cwd).toBe("/repo-b");
		const conflictedReport = output.reports.find((r) => r.branch === "feature-a");
		expect(conflictedReport?.hookNotifications).toHaveLength(0);
		const rebasedReport = output.reports.find((r) => r.branch === "feature-b");
		expect(rebasedReport?.hookNotifications).toHaveLength(1);
	});

	test("does not run hooks in dry-run mode", async () => {
		const worktrees = [mainWt, featureA, featureB];
		const git = createFakeGit({ worktrees, ...flatBranchesConfig(worktrees) });
		const shell = createFakeShell();

		const result = await updateWorktrees(
			{ dryRun: true, postUpdateHooks: ["echo done"], repoRoot: "/repo" },
			{ git, shell },
		);

		const output = expectOk(result);
		expect(shell.calls).toHaveLength(0);
		for (const report of output.reports) {
			expect(report.hookNotifications).toHaveLength(0);
		}
	});

	test("does not run hooks when no hooks configured", async () => {
		const worktrees = [mainWt, featureA];
		const git = createFakeGit({ worktrees, ...flatBranchesConfig(worktrees) });
		const shell = createFakeShell();

		const result = await updateWorktrees({ dryRun: false }, { git, shell });

		const output = expectOk(result);
		expect(shell.calls).toHaveLength(0);
		for (const report of output.reports) {
			expect(report.hookNotifications).toHaveLength(0);
		}
	});

	test("passes baseBranch (parent) in hook context", async () => {
		const main: Worktree = { path: "/repo", branch: "main", head: "aaa", isMain: true, isPrunable: false };
		const featA: Worktree = { path: "/repo-a", branch: "feat-a", head: "eee", isMain: false, isPrunable: false };
		const featSub: Worktree = { path: "/repo-sub", branch: "feat-sub", head: "ggg", isMain: false, isPrunable: false };

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

		const git = createFakeGit({ worktrees: [main, featA, featSub], mergeBaseMap, commitCountMap });
		const shell = createFakeShell();

		await updateWorktrees({ dryRun: false, postUpdateHooks: ["echo done"], repoRoot: "/repo" }, { git, shell });

		expect(shell.calls).toHaveLength(2);
		expect(shell.calls[0]?.options.env).toMatchObject({ BASE_BRANCH: "main" });
		expect(shell.calls[1]?.options.env).toMatchObject({ BASE_BRANCH: "feat-a" });
	});

	test("on-conflict hook resolves conflict — branch treated as rebased", async () => {
		const worktrees = [mainWt, featureA];
		const git = createFakeGit({
			worktrees,
			rebaseConflicts: new Set(["/repo-a"]),
			onConflictResolved: new Set(["/repo-a"]),
			...flatBranchesConfig(worktrees),
		});
		const shell = createFakeShell();

		const result = await updateWorktrees(
			{ dryRun: false, onConflictHooks: ["resolve-conflicts.sh"], repoRoot: "/repo" },
			{ git, shell },
		);

		const output = expectOk(result);
		const report = output.reports.find((r) => r.branch === "feature-a");
		expect(report?.result).toMatchObject({ status: "rebased" });
		expect(shell.calls).toHaveLength(1);
		expect(shell.calls[0]?.command).toBe("resolve-conflicts.sh");
		expect(shell.calls[0]?.options.env).toMatchObject({
			WORKTREE_PATH: "/repo-a",
			WORKTREE_BRANCH: "feature-a",
			BASE_BRANCH: "main",
		});
	});

	test("on-conflict hook fails to resolve — branch marked as conflict", async () => {
		const worktrees = [mainWt, featureA];
		const git = createFakeGit({
			worktrees,
			rebaseConflicts: new Set(["/repo-a"]),
			...flatBranchesConfig(worktrees),
		});
		const shell = createFakeShell();

		const result = await updateWorktrees(
			{ dryRun: false, onConflictHooks: ["resolve-conflicts.sh"], repoRoot: "/repo" },
			{ git, shell },
		);

		const output = expectOk(result);
		const report = output.reports.find((r) => r.branch === "feature-a");
		expect(report?.result.status).toBe("rebase-conflict");
		expect(shell.calls).toHaveLength(1);
	});

	test("conflict without on-conflict hooks — aborts as before", async () => {
		const worktrees = [mainWt, featureA];
		const git = createFakeGit({
			worktrees,
			rebaseConflicts: new Set(["/repo-a"]),
			...flatBranchesConfig(worktrees),
		});
		const shell = createFakeShell();

		const result = await updateWorktrees(
			{ dryRun: false, postUpdateHooks: ["echo done"], repoRoot: "/repo" },
			{ git, shell },
		);

		const output = expectOk(result);
		const report = output.reports.find((r) => r.branch === "feature-a");
		expect(report?.result.status).toBe("rebase-conflict");
		expect(shell.calls).toHaveLength(0);
	});

	test("does not run post-update hooks for conflict resolved by on-conflict hook", async () => {
		const worktrees = [mainWt, featureA, featureB];
		const git = createFakeGit({
			worktrees,
			rebaseConflicts: new Set(["/repo-a"]),
			onConflictResolved: new Set(["/repo-a"]),
			...flatBranchesConfig(worktrees),
		});
		const shell = createFakeShell();

		const result = await updateWorktrees(
			{
				dryRun: false,
				onConflictHooks: ["resolve-conflicts.sh"],
				postUpdateHooks: ["git push --force-with-lease"],
				repoRoot: "/repo",
			},
			{ git, shell },
		);

		const output = expectOk(result);
		const reportA = output.reports.find((r) => r.branch === "feature-a");
		expect(reportA?.result).toMatchObject({ status: "rebased" });
		// on-conflict hook + post-update hook for feature-a, post-update hook for feature-b.
		// Independent branches now rebase concurrently, so the two branches' hook calls
		// interleave; assert per-branch ordering rather than a fixed global order.
		expect(shell.calls).toHaveLength(3);
		const callsA = shell.calls.filter((c) => c.options.cwd === "/repo-a").map((c) => c.command);
		const callsB = shell.calls.filter((c) => c.options.cwd === "/repo-b").map((c) => c.command);
		expect(callsA).toEqual(["resolve-conflicts.sh", "git push --force-with-lease"]);
		expect(callsB).toEqual(["git push --force-with-lease"]);
	});

	test("continues after hook failure", async () => {
		const worktrees = [mainWt, featureA, featureB];
		const git = createFakeGit({ worktrees, ...flatBranchesConfig(worktrees) });
		const results = new Map();
		results.set("failing-hook", { success: false, error: { code: "EXECUTION_FAILED", message: "Hook failed" } });
		const shell = createFakeShell({ results });

		const result = await updateWorktrees(
			{ dryRun: false, postUpdateHooks: ["failing-hook"], repoRoot: "/repo" },
			{ git, shell },
		);

		const output = expectOk(result);
		expect(shell.calls).toHaveLength(2);
		const reportA = output.reports.find((r) => r.branch === "feature-a");
		const reportB = output.reports.find((r) => r.branch === "feature-b");
		expect(reportA?.hookNotifications).toHaveLength(1);
		expect(reportA?.hookNotifications[0]?.level).toBe("warn");
		expect(reportB?.hookNotifications).toHaveLength(1);
		expect(reportB?.hookNotifications[0]?.level).toBe("warn");
	});
});

describe("updateWorktrees — upstream sync", () => {
	test("upstream set — fast-forwards default branch from upstream remote", async () => {
		const worktrees = [mainWt, featureA];
		const mergeFFOnlyCalls: { worktreePath: string; branch: string; remote: string }[] = [];
		const git = createFakeGit({ worktrees, mergeFFOnlyCalls, ...flatBranchesConfig(worktrees) });

		const result = await updateWorktrees({ dryRun: false, upstream: "upstream" }, { git });

		const output = expectOk(result);
		expect(output.syncedFromUpstream).toBe("upstream");
		const ff = mergeFFOnlyCalls.find((c) => c.worktreePath === "/repo");
		expect(ff?.remote).toBe("upstream");
		expect(ff?.branch).toBe("main");
	});

	test("arbitrary upstream remote name — fast-forwards from that remote", async () => {
		const worktrees = [mainWt, featureA];
		const mergeFFOnlyCalls: { worktreePath: string; branch: string; remote: string }[] = [];
		const git = createFakeGit({ worktrees, mergeFFOnlyCalls, ...flatBranchesConfig(worktrees) });

		const result = await updateWorktrees({ dryRun: false, upstream: "source" }, { git });

		const output = expectOk(result);
		expect(output.syncedFromUpstream).toBe("source");
		const ff = mergeFFOnlyCalls.find((c) => c.worktreePath === "/repo");
		expect(ff?.remote).toBe("source");
	});

	test("upstream set with post-update hook — runs hook for default branch", async () => {
		const worktrees = [mainWt, featureA];
		const git = createFakeGit({ worktrees, ...flatBranchesConfig(worktrees) });
		const shell = createFakeShell();

		const result = await updateWorktrees(
			{ dryRun: false, upstream: "upstream", postUpdateHooks: ["git push origin main"], repoRoot: "/repo" },
			{ git, shell },
		);

		const output = expectOk(result);
		const mainReport = output.reports.find((r) => r.branch === "main");
		expect(mainReport?.result).toMatchObject({ status: "is-default-branch" });
		expect(mainReport?.hookNotifications).toHaveLength(1);

		const mainHookCall = shell.calls.find((c) => c.options.cwd === "/repo");
		expect(mainHookCall).toBeDefined();
		expect(mainHookCall?.options.env).toMatchObject({
			WORKTREE_BRANCH: "main",
			WORKTREE_PATH: "/repo",
			BASE_BRANCH: "upstream/main",
		});
	});

	test("upstream unset — fast-forwards from origin and no hook runs for default branch", async () => {
		const worktrees = [mainWt, featureA];
		const mergeFFOnlyCalls: { worktreePath: string; branch: string; remote: string }[] = [];
		const git = createFakeGit({ worktrees, mergeFFOnlyCalls, ...flatBranchesConfig(worktrees) });
		const shell = createFakeShell();

		const result = await updateWorktrees(
			{ dryRun: false, postUpdateHooks: ["git push"], repoRoot: "/repo" },
			{ git, shell },
		);

		const output = expectOk(result);
		expect(output.syncedFromUpstream).toBeUndefined();
		const ff = mergeFFOnlyCalls.find((c) => c.worktreePath === "/repo");
		expect(ff?.remote).toBe("origin");

		const mainReport = output.reports.find((r) => r.branch === "main");
		expect(mainReport?.hookNotifications).toHaveLength(0);
		// No hook should have run in the main worktree path.
		expect(shell.calls.find((c) => c.options.cwd === "/repo")).toBeUndefined();
	});
});

// Whether the default branch happens to be checked out decides how it is updated
// (fast-forward vs. ref fetch) — it must not decide which remote it is updated
// from, nor whether post-update hooks run for it.
describe("updateWorktrees — upstream sync without a default-branch worktree", () => {
	test("upstream set — updates the default branch ref from the upstream remote", async () => {
		const updateBranchRefCalls: { branch: string; remote: string }[] = [];
		const git = createFakeGit({
			worktrees: [featureA],
			updateBranchRefCalls,
			...flatBranchesConfig([featureA]),
		});

		const result = await updateWorktrees({ dryRun: false, upstream: "upstream" }, { git });

		const output = expectOk(result);
		expect(output.defaultBranchUpdate).toBe("ref-updated");
		expect(output.syncedFromUpstream).toBe("upstream");
		expect(updateBranchRefCalls).toEqual([{ branch: "main", remote: "upstream" }]);
	});

	test("upstream unset — updates the default branch ref from the primary remote", async () => {
		const updateBranchRefCalls: { branch: string; remote: string }[] = [];
		const git = createFakeGit({
			worktrees: [featureA],
			updateBranchRefCalls,
			...flatBranchesConfig([featureA]),
		});

		const result = await updateWorktrees({ dryRun: false }, { git });

		const output = expectOk(result);
		expect(output.syncedFromUpstream).toBeUndefined();
		expect(updateBranchRefCalls).toEqual([{ branch: "main", remote: "origin" }]);
	});

	test("upstream set with post-update hook — runs the hook for the default branch in the repo root", async () => {
		const git = createFakeGit({ worktrees: [featureA], ...flatBranchesConfig([featureA]) });
		const shell = createFakeShell();

		const result = await updateWorktrees(
			{ dryRun: false, upstream: "upstream", postUpdateHooks: ["git push origin main"], repoRoot: "/repo" },
			{ git, shell },
		);

		const output = expectOk(result);
		const mainReport = output.reports.find((r) => r.branch === "main");
		expect(mainReport?.result).toMatchObject({ status: "is-default-branch" });
		expect(mainReport?.hookNotifications).toHaveLength(1);

		// The default branch has no worktree, so the hook runs in the repo root.
		const mainHookCall = shell.calls.find((c) => c.options.env?.WORKTREE_BRANCH === "main");
		expect(mainHookCall?.options.cwd).toBe("/repo");
		expect(mainHookCall?.options.env).toMatchObject({
			WORKTREE_PATH: "/repo",
			BASE_BRANCH: "upstream/main",
		});
	});

	test("upstream unset — no hook runs for the default branch and it is not reported", async () => {
		const git = createFakeGit({ worktrees: [featureA], ...flatBranchesConfig([featureA]) });
		const shell = createFakeShell();

		const result = await updateWorktrees(
			{ dryRun: false, postUpdateHooks: ["git push"], repoRoot: "/repo" },
			{ git, shell },
		);

		const output = expectOk(result);
		expect(output.reports.find((r) => r.branch === "main")).toBeUndefined();
		expect(shell.calls.find((c) => c.options.env?.WORKTREE_BRANCH === "main")).toBeUndefined();
	});

	test("dry run with upstream — no hook runs for the default branch", async () => {
		const git = createFakeGit({ worktrees: [featureA], ...flatBranchesConfig([featureA]) });
		const shell = createFakeShell();

		const result = await updateWorktrees(
			{ dryRun: true, upstream: "upstream", postUpdateHooks: ["git push origin main"], repoRoot: "/repo" },
			{ git, shell },
		);

		expectOk(result);
		expect(shell.calls).toEqual([]);
	});
});

describe("updateWorktrees — bounded, dependency-aware concurrency (WTK-58)", () => {
	const main: Worktree = { path: "/repo", branch: "main", head: "aaa", isMain: true, isPrunable: false };

	// main ← a, a ← b, main ← c. `a` and `c` are independent; `b` depends on `a`.
	function forkConfig() {
		const a: Worktree = { path: "/repo-a", branch: "a", head: "a1", isMain: false, isPrunable: false };
		const b: Worktree = { path: "/repo-b", branch: "b", head: "b1", isMain: false, isPrunable: false };
		const c: Worktree = { path: "/repo-c", branch: "c", head: "c1", isMain: false, isPrunable: false };
		const mergeBaseMap = new Map([
			["a:main", "aaa"],
			["main:a", "aaa"],
			["b:main", "aaa"],
			["main:b", "aaa"],
			["b:a", "eee"],
			["a:b", "eee"],
			["c:main", "aaa"],
			["main:c", "aaa"],
		]);
		const commitCountMap = new Map([
			["aaa..a", 2],
			["aaa..b", 4],
			["eee..b", 2],
			["aaa..c", 2],
			["eee..a", 0],
		]);
		return { worktrees: [main, a, b, c], mergeBaseMap, commitCountMap };
	}

	test("R3: a child never starts before its parent finishes; independent siblings overlap", async () => {
		const { worktrees, mergeBaseMap, commitCountMap } = forkConfig();
		const base = createFakeGit({ worktrees, mergeBaseMap, commitCountMap });
		const { git, tracker } = instrumentRebase(base);

		const output = expectOk(await updateWorktrees({ dryRun: false }, { git }));

		expect(output.reports.find((r) => r.branch === "a")?.parent).toBe("main");
		expect(output.reports.find((r) => r.branch === "b")?.parent).toBe("a");
		expect(output.reports.find((r) => r.branch === "c")?.parent).toBe("main");

		const aEnd = tracker.events.findIndex((e) => e.path === "/repo-a" && e.phase === "end");
		const bStart = tracker.events.findIndex((e) => e.path === "/repo-b" && e.phase === "start");
		const cStart = tracker.events.findIndex((e) => e.path === "/repo-c" && e.phase === "start");

		// b (child of a) starts rebasing only after a has finished.
		expect(bStart).toBeGreaterThan(aEnd);
		// a and c (both children of main) overlap: c starts before a finishes.
		expect(cStart).toBeLessThan(aEnd);
		expect(tracker.peak).toBeGreaterThanOrEqual(2);
	});

	test("R4: --jobs bounds concurrent rebases; the default caps at 4", async () => {
		const feats: Worktree[] = [1, 2, 3, 4, 5].map((n) => ({
			path: `/repo-${n}`,
			branch: `f${n}`,
			head: `h${n}`,
			isMain: false,
			isPrunable: false,
		}));
		const worktrees = [main, ...feats];
		const config = flatBranchesConfig(worktrees);

		const capped = instrumentRebase(createFakeGit({ worktrees, ...config }));
		expectOk(await updateWorktrees({ dryRun: false, jobs: 2 }, { git: capped.git }));
		expect(capped.tracker.peak).toBe(2);

		const dflt = instrumentRebase(createFakeGit({ worktrees, ...config }));
		expectOk(await updateWorktrees({ dryRun: false }, { git: dflt.git }));
		expect(dflt.tracker.peak).toBe(4);
	});

	test("R5: a conflicting parent skips all its descendants under concurrency", async () => {
		const a: Worktree = { path: "/repo-a", branch: "a", head: "a1", isMain: false, isPrunable: false };
		const b: Worktree = { path: "/repo-b", branch: "b", head: "b1", isMain: false, isPrunable: false };
		const c: Worktree = { path: "/repo-c", branch: "c", head: "c1", isMain: false, isPrunable: false };
		const mergeBaseMap = new Map([
			["a:main", "aaa"],
			["main:a", "aaa"],
			["b:main", "aaa"],
			["main:b", "aaa"],
			["b:a", "eee"],
			["a:b", "eee"],
			["c:main", "aaa"],
			["main:c", "aaa"],
			["c:a", "eee"],
			["a:c", "eee"],
		]);
		const commitCountMap = new Map([
			["aaa..a", 2],
			["aaa..b", 4],
			["eee..b", 2],
			["aaa..c", 4],
			["eee..c", 2],
			["eee..a", 0],
		]);
		const rebaseCalls: FakeRebaseCall[] = [];
		const base = createFakeGit({
			worktrees: [main, a, b, c],
			mergeBaseMap,
			commitCountMap,
			rebaseConflicts: new Set(["/repo-a"]),
			rebaseCalls,
		});
		const { git } = instrumentRebase(base);

		const output = expectOk(await updateWorktrees({ dryRun: false }, { git }));

		expect(output.reports.find((r) => r.branch === "a")?.result.status).toBe("rebase-conflict");
		expect(output.reports.find((r) => r.branch === "b")?.result).toMatchObject({
			status: "skipped",
			reason: "parent a failed",
		});
		expect(output.reports.find((r) => r.branch === "c")?.result).toMatchObject({
			status: "skipped",
			reason: "parent a failed",
		});
		// Only the parent ever attempted a rebase; the skipped descendants did not.
		expect(rebaseCalls.map((call) => call.worktreePath)).toEqual(["/repo-a"]);
	});
});

// WTK-52: `wt update --dry-run` must not advance the default branch. The sync
// (mergeFFOnly / updateBranchRef) is skipped and the report previews the advance
// instead of claiming a completed action.
describe("updateWorktrees — dry-run leaves the default branch untouched (WTK-52)", () => {
	test("R1: main worktree behind upstream — mergeFFOnly is not called on dry-run", async () => {
		const worktrees = [mainWt, featureA];
		const mergeFFOnlyCalls: { worktreePath: string; branch: string; remote: string }[] = [];
		const git = createFakeGit({ worktrees, mergeFFOnlyCalls, ...flatBranchesConfig(worktrees) });

		const result = await updateWorktrees({ dryRun: true }, { git });

		expectOk(result);
		expect(mergeFFOnlyCalls).toEqual([]);
	});

	test("R1: no main worktree behind upstream — updateBranchRef is not called on dry-run", async () => {
		const updateBranchRefCalls: { branch: string; remote: string }[] = [];
		const git = createFakeGit({
			worktrees: [featureA],
			updateBranchRefCalls,
			...flatBranchesConfig([featureA]),
		});

		const result = await updateWorktrees({ dryRun: true }, { git });

		expectOk(result);
		expect(updateBranchRefCalls).toEqual([]);
	});

	test("R2: default branch behind upstream — output previews a would-be advance, not a completed action", async () => {
		const worktrees = [mainWt, featureA];
		const config = flatBranchesConfig(worktrees);
		// How far the default branch is behind its tracking ref (best-effort preview).
		config.commitCountMap.set("main..main@{u}", 3);
		const mergeFFOnlyCalls: { worktreePath: string; branch: string; remote: string }[] = [];
		const git = createFakeGit({ worktrees, mergeFFOnlyCalls, ...config });

		const result = await updateWorktrees({ dryRun: true }, { git });

		const output = expectOk(result);
		expect(output.defaultBranchUpdate).toBe("would-update");
		expect(output.defaultBranchBehind).toBe(3);
		expect(output.syncedFromUpstream).toBeUndefined();
		expect(mergeFFOnlyCalls).toEqual([]);
	});

	test("R2: dry-run with upstream — does not report the default branch as synced from upstream", async () => {
		const worktrees = [mainWt, featureA];
		const config = flatBranchesConfig(worktrees);
		config.commitCountMap.set("main..upstream/main", 2);
		const mergeFFOnlyCalls: { worktreePath: string; branch: string; remote: string }[] = [];
		const git = createFakeGit({ worktrees, mergeFFOnlyCalls, ...config });

		const result = await updateWorktrees({ dryRun: true, upstream: "upstream" }, { git });

		const output = expectOk(result);
		expect(output.syncedFromUpstream).toBeUndefined();
		expect(output.defaultBranchUpdate).toBe("would-update");
		expect(output.defaultBranchBehind).toBe(2);
		expect(mergeFFOnlyCalls).toEqual([]);
	});
});

// WTK-61: a diverged default branch no longer aborts `wt update`. When every local
// default-branch commit is already upstream (squash-merge) it is reset to the remote;
// genuine local work is left untouched with a warning. Feature branches rebase either way.
describe("updateWorktrees — default-branch divergence (WTK-61)", () => {
	type ResetCall = { worktreePath: string; branch: string; remote: string };
	type ForceRefCall = { branch: string; remote: string };

	/** Wire the fake so `findMergedPrefix(base=<ref>, feature=main)` reports fully-merged (all cherry-picked). */
	function fullyMergedMaps(ref: string): {
		revListMap: Map<string, string[]>;
		revListCherryPickMap: Map<string, string[]>;
	} {
		return {
			revListMap: new Map([[`${ref}..main`, ["c1"]]]),
			revListCherryPickMap: new Map([[`${ref}...main`, []]]),
		};
	}

	/** Wire the fake so the divergence is genuine (no commit is cherry-picked upstream). */
	function genuineDivergenceMaps(ref: string): {
		revListMap: Map<string, string[]>;
		revListCherryPickMap: Map<string, string[]>;
	} {
		return {
			revListMap: new Map([[`${ref}..main`, ["c2", "c1"]]]),
			revListCherryPickMap: new Map([[`${ref}...main`, ["c2", "c1"]]]),
		};
	}

	test("R1/R5(worktree): fully-merged divergence with a worktree → hard-resets the worktree, run continues", async () => {
		const worktrees = [mainWt, featureA];
		const base = flatBranchesConfig(worktrees);
		base.commitCountMap.set("origin/main..main", 1);
		const resetHardToRemoteCalls: ResetCall[] = [];
		const forceUpdateBranchRefCalls: ForceRefCall[] = [];
		const git = createFakeGit({
			worktrees,
			mergeFFOnlyFails: true,
			resetHardToRemoteCalls,
			forceUpdateBranchRefCalls,
			...fullyMergedMaps("origin/main"),
			...base,
		});

		const output = expectOk(await updateWorktrees({ dryRun: false }, { git }));

		expect(output.defaultBranchUpdate).toBe("reset");
		expect(output.defaultBranchRemoteRef).toBe("origin/main");
		// The worktree hard-reset variant runs with the worktree path; the ref variant does not.
		expect(resetHardToRemoteCalls).toEqual([{ worktreePath: "/repo", branch: "main", remote: "origin" }]);
		expect(forceUpdateBranchRefCalls).toEqual([]);
		// Feature branches still rebase.
		expect(output.reports.find((r) => r.branch === "feature-a")?.result.status).toBe("rebased");
	});

	test("R5(ref): fully-merged divergence with no worktree → force-updates the ref, no working-tree reset", async () => {
		const worktrees = [featureA];
		const base = flatBranchesConfig(worktrees);
		base.commitCountMap.set("origin/main..main", 1);
		const resetHardToRemoteCalls: ResetCall[] = [];
		const forceUpdateBranchRefCalls: ForceRefCall[] = [];
		const git = createFakeGit({
			worktrees,
			mergeFFOnlyFails: true,
			resetHardToRemoteCalls,
			forceUpdateBranchRefCalls,
			...fullyMergedMaps("origin/main"),
			...base,
		});

		const output = expectOk(await updateWorktrees({ dryRun: false }, { git }));

		expect(output.defaultBranchUpdate).toBe("reset");
		expect(forceUpdateBranchRefCalls).toEqual([{ branch: "main", remote: "origin" }]);
		expect(resetHardToRemoteCalls).toEqual([]);
		expect(output.reports.find((r) => r.branch === "feature-a")?.result.status).toBe("rebased");
	});

	test("R5(upstream): the reset target uses <upstream>/<defaultBranch>", async () => {
		const worktrees = [mainWt, featureA];
		const base = flatBranchesConfig(worktrees);
		base.commitCountMap.set("upstream/main..main", 1);
		const resetHardToRemoteCalls: ResetCall[] = [];
		const git = createFakeGit({
			worktrees,
			mergeFFOnlyFails: true,
			resetHardToRemoteCalls,
			...fullyMergedMaps("upstream/main"),
			...base,
		});

		const output = expectOk(await updateWorktrees({ dryRun: false, upstream: "upstream" }, { git }));

		expect(output.defaultBranchUpdate).toBe("reset");
		expect(output.defaultBranchRemoteRef).toBe("upstream/main");
		expect(resetHardToRemoteCalls).toEqual([{ worktreePath: "/repo", branch: "main", remote: "upstream" }]);
	});

	test("R3: dirty default-branch worktree → no reset even when fully merged, skipped-diverged", async () => {
		const worktrees = [mainWt, featureA];
		const base = flatBranchesConfig(worktrees);
		base.commitCountMap.set("origin/main..main", 1);
		const resetHardToRemoteCalls: ResetCall[] = [];
		const git = createFakeGit({
			worktrees,
			mergeFFOnlyFails: true,
			dirtyWorktrees: new Set(["/repo"]),
			resetHardToRemoteCalls,
			...fullyMergedMaps("origin/main"),
			...base,
		});

		const output = expectOk(await updateWorktrees({ dryRun: false }, { git }));

		expect(output.defaultBranchUpdate).toBe("skipped-diverged");
		expect(resetHardToRemoteCalls).toEqual([]);
		expect(output.reports.find((r) => r.branch === "feature-a")?.result.status).toBe("rebased");
	});

	test("R4(fork skip): upstream + genuine divergence → ok, no syncedFromUpstream, no default-branch hooks", async () => {
		const worktrees = [mainWt, featureA];
		const base = flatBranchesConfig(worktrees);
		base.commitCountMap.set("upstream/main..main", 2);
		const git = createFakeGit({
			worktrees,
			mergeFFOnlyFails: true,
			...genuineDivergenceMaps("upstream/main"),
			...base,
		});
		const shell = createFakeShell();

		const output = expectOk(
			await updateWorktrees(
				{ dryRun: false, upstream: "upstream", postUpdateHooks: ["git push"], repoRoot: "/repo" },
				{ git, shell },
			),
		);

		expect(output.defaultBranchUpdate).toBe("skipped-diverged");
		expect(output.syncedFromUpstream).toBeUndefined();
		expect(output.reports.find((r) => r.branch === "main")?.hookNotifications ?? []).toHaveLength(0);
		// No default-branch post-update hook ran in the main worktree.
		expect(shell.calls.find((c) => c.options.cwd === "/repo")).toBeUndefined();
	});

	test("R4(fork skip, dirty): upstream + dirty worktree → ok, no syncedFromUpstream, no default-branch hooks", async () => {
		const worktrees = [mainWt, featureA];
		const base = flatBranchesConfig(worktrees);
		base.commitCountMap.set("upstream/main..main", 1);
		const git = createFakeGit({
			worktrees,
			mergeFFOnlyFails: true,
			dirtyWorktrees: new Set(["/repo"]),
			...fullyMergedMaps("upstream/main"),
			...base,
		});
		const shell = createFakeShell();

		const output = expectOk(
			await updateWorktrees(
				{ dryRun: false, upstream: "upstream", postUpdateHooks: ["git push"], repoRoot: "/repo" },
				{ git, shell },
			),
		);

		expect(output.defaultBranchUpdate).toBe("skipped-diverged");
		expect(output.syncedFromUpstream).toBeUndefined();
		expect(shell.calls.find((c) => c.options.cwd === "/repo")).toBeUndefined();
	});

	test("R6(would-reset): dry-run diverged + fully merged → would-reset, no mutation", async () => {
		const worktrees = [mainWt, featureA];
		const base = flatBranchesConfig(worktrees);
		base.commitCountMap.set("main..main@{u}", 1);
		base.commitCountMap.set("main@{u}..main", 1);
		const mergeFFOnlyCalls: { worktreePath: string; branch: string; remote: string }[] = [];
		const updateBranchRefCalls: ForceRefCall[] = [];
		const resetHardToRemoteCalls: ResetCall[] = [];
		const forceUpdateBranchRefCalls: ForceRefCall[] = [];
		const git = createFakeGit({
			worktrees,
			mergeFFOnlyCalls,
			updateBranchRefCalls,
			resetHardToRemoteCalls,
			forceUpdateBranchRefCalls,
			...fullyMergedMaps("main@{u}"),
			...base,
		});

		const output = expectOk(await updateWorktrees({ dryRun: true }, { git }));

		expect(output.defaultBranchUpdate).toBe("would-reset");
		// No mutating primitive runs under dry-run.
		expect(mergeFFOnlyCalls).toEqual([]);
		expect(updateBranchRefCalls).toEqual([]);
		expect(resetHardToRemoteCalls).toEqual([]);
		expect(forceUpdateBranchRefCalls).toEqual([]);
	});

	test("R6(would-skip): dry-run genuinely diverged → would-skip-diverged, no mutation", async () => {
		const worktrees = [mainWt, featureA];
		const base = flatBranchesConfig(worktrees);
		base.commitCountMap.set("main..main@{u}", 2);
		base.commitCountMap.set("main@{u}..main", 2);
		const mergeFFOnlyCalls: { worktreePath: string; branch: string; remote: string }[] = [];
		const updateBranchRefCalls: ForceRefCall[] = [];
		const resetHardToRemoteCalls: ResetCall[] = [];
		const forceUpdateBranchRefCalls: ForceRefCall[] = [];
		const git = createFakeGit({
			worktrees,
			mergeFFOnlyCalls,
			updateBranchRefCalls,
			resetHardToRemoteCalls,
			forceUpdateBranchRefCalls,
			...genuineDivergenceMaps("main@{u}"),
			...base,
		});

		const output = expectOk(await updateWorktrees({ dryRun: true }, { git }));

		expect(output.defaultBranchUpdate).toBe("would-skip-diverged");
		// No mutating primitive runs under dry-run.
		expect(mergeFFOnlyCalls).toEqual([]);
		expect(updateBranchRefCalls).toEqual([]);
		expect(resetHardToRemoteCalls).toEqual([]);
		expect(forceUpdateBranchRefCalls).toEqual([]);
	});
});

// WTK-64: a fork can have more than one long-lived root (default branch + any
// branch mirroring a different upstream branch, e.g. `core`). Each local root is
// synced from its own `<upstream>/<name>` and is a rebase base; a root that lives
// only on the upstream remote is a rebase target via its remote-tracking ref.
describe("updateWorktrees — multiple upstream roots (WTK-64)", () => {
	type FfCall = { worktreePath: string; branch: string; remote: string };
	type RefCall = { branch: string; remote: string };
	type ResetCall = { worktreePath: string; branch: string; remote: string };

	const coreWt: Worktree = { path: "/repo-core", branch: "core", head: "cTip", isMain: false, isPrunable: false };
	const featF: Worktree = { path: "/repo-f", branch: "f", head: "fTip", isMain: false, isPrunable: false };

	test("R1: a local core root with a worktree is fast-forwarded from upstream/core, never rebased onto main", async () => {
		const mergeFFOnlyCalls: FfCall[] = [];
		const rebaseCalls: FakeRebaseCall[] = [];
		const git = createFakeGit({
			worktrees: [mainWt, coreWt],
			branches: ["main", "core"],
			remoteBranchesByRemote: new Map([["upstream", ["main", "core"]]]),
			mergeFFOnlyCalls,
			rebaseCalls,
		});

		const output = expectOk(await updateWorktrees({ dryRun: false, upstream: "upstream" }, { git }));

		expect(mergeFFOnlyCalls).toContainEqual({ worktreePath: "/repo-core", branch: "core", remote: "upstream" });
		expect(rebaseCalls.find((c) => c.worktreePath === "/repo-core")).toBeUndefined();
		const coreSync = output.rootSyncs.find((r) => r.branch === "core");
		expect(coreSync?.update).toBe("ff-updated");
		expect(coreSync?.syncedFromUpstream).toBe("upstream");
		// A root is not a feature: it must not appear in the per-worktree rebase reports.
		expect(output.reports.find((r) => r.branch === "core")).toBeUndefined();
	});

	test("R1 (hooks): a synced checked-out non-default root runs its post-update hooks", async () => {
		const shell = createFakeShell();
		const git = createFakeGit({
			worktrees: [mainWt, coreWt],
			branches: ["main", "core"],
			remoteBranchesByRemote: new Map([["upstream", ["main", "core"]]]),
		});

		const output = expectOk(
			await updateWorktrees(
				{ dryRun: false, upstream: "upstream", postUpdateHooks: ["echo done"], repoRoot: "/repo" },
				{ git, shell },
			),
		);

		const coreSync = output.rootSyncs.find((r) => r.branch === "core");
		expect(coreSync?.update).toBe("ff-updated");
		expect(coreSync?.hookNotifications).toHaveLength(1);
		expect(coreSync?.hookNotifications?.[0]?.level).toBe("info");
	});

	test("R1: a local root with no worktree has its ref advanced from upstream via updateBranchRef", async () => {
		const updateBranchRefCalls: RefCall[] = [];
		const git = createFakeGit({
			worktrees: [mainWt, featureA],
			branches: ["main", "core", "feature-a"],
			remoteBranchesByRemote: new Map([["upstream", ["main", "core"]]]),
			updateBranchRefCalls,
			...flatBranchesConfig([mainWt, featureA]),
		});

		const output = expectOk(await updateWorktrees({ dryRun: false, upstream: "upstream" }, { git }));

		expect(updateBranchRefCalls).toContainEqual({ branch: "core", remote: "upstream" });
		expect(output.rootSyncs.find((r) => r.branch === "core")?.update).toBe("ref-updated");
	});

	test("R2: a feature built on a local core root rebases onto core, not main", async () => {
		const rebaseCalls: FakeRebaseCall[] = [];
		const git = createFakeGit({
			worktrees: [mainWt, coreWt, featF],
			branches: ["main", "core", "f"],
			remoteBranchesByRemote: new Map([["upstream", ["main", "core"]]]),
			rebaseCalls,
			mergeBaseMap: new Map([
				["f:main", "root"],
				["main:f", "root"],
				["f:core", "cTip"],
				["core:f", "cTip"],
			]),
			commitCountMap: new Map([
				["root..f", 5],
				["cTip..f", 2],
				["cTip..core", 0],
			]),
		});

		const output = expectOk(await updateWorktrees({ dryRun: false, upstream: "upstream" }, { git }));

		const fReport = output.reports.find((r) => r.branch === "f");
		expect(fReport?.parent).toBe("core");
		expect(fReport?.result.status).toBe("rebased");
		expect(rebaseCalls.find((c) => c.worktreePath === "/repo-f")?.onto).toBe("core");
	});

	test("R3: a feature whose base exists only on upstream rebases onto <upstream>/core and no local core is created", async () => {
		const rebaseCalls: FakeRebaseCall[] = [];
		const updateBranchRefCalls: RefCall[] = [];
		const mergeFFOnlyCalls: FfCall[] = [];
		const git = createFakeGit({
			worktrees: [mainWt, featF],
			branches: ["main", "f"], // no local core
			remoteBranchesByRemote: new Map([["upstream", ["main", "core"]]]),
			rebaseCalls,
			updateBranchRefCalls,
			mergeFFOnlyCalls,
			mergeBaseMap: new Map([
				["f:main", "root"],
				["main:f", "root"],
				["f:upstream/core", "cTip"],
				["upstream/core:f", "cTip"],
			]),
			commitCountMap: new Map([
				["root..f", 5],
				["cTip..f", 2],
				["cTip..upstream/core", 0],
			]),
		});

		const output = expectOk(await updateWorktrees({ dryRun: false, upstream: "upstream" }, { git }));

		const fReport = output.reports.find((r) => r.branch === "f");
		expect(fReport?.parent).toBe("upstream/core");
		expect(rebaseCalls.find((c) => c.worktreePath === "/repo-f")?.onto).toBe("upstream/core");
		// The absent root is a rebase target only — never synced, never created as a local branch.
		expect(updateBranchRefCalls.find((c) => c.branch === "core")).toBeUndefined();
		expect(mergeFFOnlyCalls.find((c) => c.branch === "core")).toBeUndefined();
		expect(output.rootSyncs.find((r) => r.branch === "core")).toBeUndefined();
	});

	test("R2 (advanced root): a feature on local core rebases onto core even after core advanced past the fork point", async () => {
		const rebaseCalls: FakeRebaseCall[] = [];
		const git = createFakeGit({
			worktrees: [mainWt, coreWt, featF],
			branches: ["main", "core", "f"],
			remoteBranchesByRemote: new Map([["upstream", ["main", "core"]]]),
			rebaseCalls,
			mergeBaseMap: new Map([
				["f:main", "root"],
				["main:f", "root"],
				["f:core", "C0"],
				["core:f", "C0"],
			]),
			commitCountMap: new Map([
				["root..f", 10],
				["C0..f", 2],
				// core was synced forward and now sits 3 commits past f's fork — no longer a
				// strict ancestor of f, but still f's base.
				["C0..core", 3],
			]),
		});

		const output = expectOk(await updateWorktrees({ dryRun: false, upstream: "upstream" }, { git }));

		const fReport = output.reports.find((r) => r.branch === "f");
		expect(fReport?.parent).toBe("core");
		expect(rebaseCalls.find((c) => c.worktreePath === "/repo-f")?.onto).toBe("core");
	});

	test("R3 (advanced absent root): a feature rebases onto upstream/core even after fetch advanced it past the fork", async () => {
		const rebaseCalls: FakeRebaseCall[] = [];
		const git = createFakeGit({
			worktrees: [mainWt, featF],
			branches: ["main", "f"],
			remoteBranchesByRemote: new Map([["upstream", ["main", "core"]]]),
			rebaseCalls,
			mergeBaseMap: new Map([
				["f:main", "root"],
				["main:f", "root"],
				["f:upstream/core", "C0"],
				["upstream/core:f", "C0"],
			]),
			commitCountMap: new Map([
				["root..f", 10],
				["C0..f", 2],
				// fetch advanced upstream/core 3 commits past f's fork.
				["C0..upstream/core", 3],
			]),
		});

		const output = expectOk(await updateWorktrees({ dryRun: false, upstream: "upstream" }, { git }));

		const fReport = output.reports.find((r) => r.branch === "f");
		expect(fReport?.parent).toBe("upstream/core");
		expect(rebaseCalls.find((c) => c.worktreePath === "/repo-f")?.onto).toBe("upstream/core");
	});

	test("R4: sibling features off the same root tip resolve to the root, not to each other", async () => {
		const aWt: Worktree = { path: "/repo-a", branch: "a", head: "aTip", isMain: false, isPrunable: false };
		const bWt: Worktree = { path: "/repo-b", branch: "b", head: "bTip", isMain: false, isPrunable: false };
		const git = createFakeGit({
			worktrees: [mainWt, coreWt, aWt, bWt],
			branches: ["main", "core", "a", "b"],
			remoteBranchesByRemote: new Map([["upstream", ["main", "core"]]]),
			mergeBaseMap: new Map([
				["a:main", "root"],
				["main:a", "root"],
				["b:main", "root"],
				["main:b", "root"],
				["a:core", "cTip"],
				["core:a", "cTip"],
				["b:core", "cTip"],
				["core:b", "cTip"],
				["a:b", "cTip"],
				["b:a", "cTip"],
			]),
			commitCountMap: new Map([
				["root..a", 4],
				["root..b", 4],
				["cTip..a", 1],
				["cTip..b", 1],
				["cTip..core", 0],
			]),
		});

		const output = expectOk(await updateWorktrees({ dryRun: false, upstream: "upstream" }, { git }));

		expect(output.reports.find((r) => r.branch === "a")?.parent).toBe("core");
		expect(output.reports.find((r) => r.branch === "b")?.parent).toBe("core");
	});

	test("R4: a feature contained by both main and core picks core, the nearer ancestor", async () => {
		const rebaseCalls: FakeRebaseCall[] = [];
		const git = createFakeGit({
			worktrees: [mainWt, coreWt, featF],
			branches: ["main", "core", "f"],
			remoteBranchesByRemote: new Map([["upstream", ["main", "core"]]]),
			rebaseCalls,
			mergeBaseMap: new Map([
				["f:main", "root"],
				["main:f", "root"],
				["f:core", "cTip"],
				["core:f", "cTip"],
			]),
			commitCountMap: new Map([
				// f fully contains both main (root..main==0 via default handling) and core.
				["root..f", 6],
				["cTip..f", 2],
				["cTip..core", 0],
			]),
		});

		const output = expectOk(await updateWorktrees({ dryRun: false, upstream: "upstream" }, { git }));

		// main is a (farther) ancestor; core wins because it is nearer.
		expect(output.reports.find((r) => r.branch === "f")?.parent).toBe("core");
		expect(rebaseCalls.find((c) => c.worktreePath === "/repo-f")?.onto).toBe("core");
	});

	test("R4 (guard): a non-ancestor sibling that is strictly nearer than every root is still excluded", async () => {
		// Topology: main(M) → core(C) → X → {a, b}. The two features share the deeper
		// base X, so mergeBase(a,b)=X gives the sibling distance 1 — STRICTLY nearer than
		// the true ancestor core (distance 2) or main (distance 3). Only the true-ancestor
		// guard keeps `a` off `b`; without it `a` wrongly rebases onto its sibling and
		// history is corrupted. (Unlike the same-tip sibling case, `core` cannot win here
		// by a distance tie or stable-sort order — the sibling is the nearest candidate.)
		const aWt: Worktree = { path: "/repo-a", branch: "a", head: "aTip", isMain: false, isPrunable: false };
		const bWt: Worktree = { path: "/repo-b", branch: "b", head: "bTip", isMain: false, isPrunable: false };
		const rebaseCalls: FakeRebaseCall[] = [];
		const git = createFakeGit({
			worktrees: [mainWt, coreWt, aWt, bWt],
			branches: ["main", "core", "a", "b"],
			remoteBranchesByRemote: new Map([["upstream", ["main", "core"]]]),
			rebaseCalls,
			mergeBaseMap: new Map([
				["a:main", "M"],
				["b:main", "M"],
				["a:core", "C"],
				["b:core", "C"],
				["a:b", "X"],
				["b:a", "X"],
			]),
			commitCountMap: new Map([
				["M..a", 3],
				["M..b", 3],
				["C..a", 2],
				["C..b", 2],
				["C..core", 0],
				["X..a", 1],
				["X..b", 1],
			]),
		});

		const output = expectOk(await updateWorktrees({ dryRun: false, upstream: "upstream" }, { git }));

		// The strictly-nearer sibling must NOT be chosen: each feature resolves to its
		// true-ancestor root, never to the other feature.
		expect(output.reports.find((r) => r.branch === "a")?.parent).toBe("core");
		expect(output.reports.find((r) => r.branch === "b")?.parent).toBe("core");
		expect(rebaseCalls.find((c) => c.worktreePath === "/repo-a")?.onto).toBe("core");
		expect(rebaseCalls.find((c) => c.worktreePath === "/repo-b")?.onto).toBe("core");
	});

	test("R5 (safe reset): a fully-merged diverged core root is reset to upstream/core; features still rebase onto it", async () => {
		const resetHardToRemoteCalls: ResetCall[] = [];
		const git = createFakeGit({
			worktrees: [mainWt, coreWt, featF],
			branches: ["main", "core", "f"],
			remoteBranchesByRemote: new Map([["upstream", ["main", "core"]]]),
			mergeFFOnlyFailBranches: new Set(["core"]),
			resetHardToRemoteCalls,
			revListMap: new Map([["upstream/core..core", ["cc1"]]]),
			revListCherryPickMap: new Map([["upstream/core...core", []]]),
			mergeBaseMap: new Map([
				["f:main", "root"],
				["main:f", "root"],
				["f:core", "cTip"],
				["core:f", "cTip"],
			]),
			commitCountMap: new Map([
				["upstream/core..core", 1],
				["root..f", 5],
				["cTip..f", 2],
				["cTip..core", 0],
			]),
		});

		const output = expectOk(await updateWorktrees({ dryRun: false, upstream: "upstream" }, { git }));

		const coreSync = output.rootSyncs.find((r) => r.branch === "core");
		expect(coreSync?.update).toBe("reset");
		expect(coreSync?.remoteRef).toBe("upstream/core");
		expect(resetHardToRemoteCalls).toContainEqual({ worktreePath: "/repo-core", branch: "core", remote: "upstream" });
		// The default root is healthy and still synced; the run does not abort.
		expect(output.defaultBranchUpdate).toBe("ff-updated");
		const fReport = output.reports.find((r) => r.branch === "f");
		expect(fReport?.parent).toBe("core");
		expect(fReport?.result.status).toBe("rebased");
	});

	test("R5 (genuine skip): a genuinely diverged core root is left unchanged with a warning; the run continues", async () => {
		const resetHardToRemoteCalls: ResetCall[] = [];
		const git = createFakeGit({
			worktrees: [mainWt, coreWt, featF],
			branches: ["main", "core", "f"],
			remoteBranchesByRemote: new Map([["upstream", ["main", "core"]]]),
			mergeFFOnlyFailBranches: new Set(["core"]),
			resetHardToRemoteCalls,
			revListMap: new Map([["upstream/core..core", ["cc2", "cc1"]]]),
			revListCherryPickMap: new Map([["upstream/core...core", ["cc2", "cc1"]]]),
			mergeBaseMap: new Map([
				["f:main", "root"],
				["main:f", "root"],
				["f:core", "cTip"],
				["core:f", "cTip"],
			]),
			commitCountMap: new Map([
				["upstream/core..core", 2],
				["root..f", 5],
				["cTip..f", 2],
				["cTip..core", 0],
			]),
		});

		const output = expectOk(await updateWorktrees({ dryRun: false, upstream: "upstream" }, { git }));

		expect(output.rootSyncs.find((r) => r.branch === "core")?.update).toBe("skipped-diverged");
		expect(resetHardToRemoteCalls).toEqual([]);
		expect(output.defaultBranchUpdate).toBe("ff-updated");
		// Feature on the skipped root still rebases onto its (un-advanced) local position.
		expect(output.reports.find((r) => r.branch === "f")?.result.status).toBe("rebased");
	});

	test("R5 (dirty guard): a dirty checked-out core root is not reset even when fully merged; it is skipped and the run continues", async () => {
		const resetHardToRemoteCalls: ResetCall[] = [];
		const git = createFakeGit({
			worktrees: [mainWt, coreWt, featF],
			branches: ["main", "core", "f"],
			remoteBranchesByRemote: new Map([["upstream", ["main", "core"]]]),
			mergeFFOnlyFailBranches: new Set(["core"]),
			dirtyWorktrees: new Set(["/repo-core"]),
			resetHardToRemoteCalls,
			revListMap: new Map([["upstream/core..core", ["cc1"]]]),
			revListCherryPickMap: new Map([["upstream/core...core", []]]),
			mergeBaseMap: new Map([
				["f:main", "root"],
				["main:f", "root"],
				["f:core", "cTip"],
				["core:f", "cTip"],
			]),
			commitCountMap: new Map([
				["upstream/core..core", 1],
				["root..f", 5],
				["cTip..f", 2],
				["cTip..core", 0],
			]),
		});

		const output = expectOk(await updateWorktrees({ dryRun: false, upstream: "upstream" }, { git }));

		expect(output.rootSyncs.find((r) => r.branch === "core")?.update).toBe("skipped-diverged");
		expect(resetHardToRemoteCalls).toEqual([]);
		expect(output.reports.find((r) => r.branch === "f")?.result.status).toBe("rebased");
	});

	test("R6: with no upstream resolved the default branch is the only root and there are no extra root syncs", async () => {
		const git = createFakeGit({ worktrees: [mainWt, featureA], ...flatBranchesConfig([mainWt, featureA]) });

		const output = expectOk(await updateWorktrees({ dryRun: false }, { git }));

		expect(output.rootSyncs).toEqual([]);
		expect(output.reports.find((r) => r.branch === "feature-a")?.parent).toBe("main");
	});
});
