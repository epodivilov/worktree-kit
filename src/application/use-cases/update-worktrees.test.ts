import { describe, expect, test } from "bun:test";
import type { Worktree } from "../../domain/entities/worktree.ts";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { createFakeShell } from "../../test-utils/fake-shell.ts";
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

describe("updateWorktrees — fresh branch (zero commits from default)", () => {
	test("fresh branch with no own commits — parent is defaultBranch, not another worktree", async () => {
		const main: Worktree = { path: "/repo", branch: "main", head: "aaa", isMain: true };
		const featA: Worktree = { path: "/repo-a", branch: "feat-a", head: "ddd", isMain: false };
		const fresh: Worktree = { path: "/repo-fresh", branch: "fresh", head: "aaa", isMain: false };

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
		const main: Worktree = { path: "/repo", branch: "main", head: "aaa", isMain: true };
		const featA: Worktree = { path: "/repo-a", branch: "feat-a", head: "eee", isMain: false };
		const featSub: Worktree = { path: "/repo-sub", branch: "feat-sub", head: "ggg", isMain: false };
		const featB: Worktree = { path: "/repo-b", branch: "feat-b", head: "hhh", isMain: false };

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
		// on-conflict hook + post-update hook for feature-a, post-update hook for feature-b
		expect(shell.calls).toHaveLength(3);
		expect(shell.calls[0]?.command).toBe("resolve-conflicts.sh");
		expect(shell.calls[0]?.options.cwd).toBe("/repo-a");
		expect(shell.calls[1]?.command).toBe("git push --force-with-lease");
		expect(shell.calls[1]?.options.cwd).toBe("/repo-a");
		expect(shell.calls[2]?.command).toBe("git push --force-with-lease");
		expect(shell.calls[2]?.options.cwd).toBe("/repo-b");
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
