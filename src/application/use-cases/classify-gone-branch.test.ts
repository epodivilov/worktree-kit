import { describe, expect, test } from "bun:test";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { classifyGoneBranch } from "./classify-gone-branch.ts";

describe("classifyGoneBranch", () => {
	test("worktree + dirty + !force → skipped-dirty", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			dirtyWorktrees: new Set(["/wt/feature"]),
		});
		const result = await classifyGoneBranch(
			{ branch: "feature", defaultBranch: "main", worktreePath: "/wt/feature", force: false },
			{ git },
		);
		expect(result).toBe("skipped-dirty");
	});

	test("worktree + dirty + force → merged", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			dirtyWorktrees: new Set(["/wt/feature"]),
		});
		const result = await classifyGoneBranch(
			{ branch: "feature", defaultBranch: "main", worktreePath: "/wt/feature", force: true },
			{ git },
		);
		expect(result).toBe("merged");
	});

	test("no worktree + ahead=0 → empty", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			commitCountMap: new Map([["main..feature", 0]]),
		});
		const result = await classifyGoneBranch(
			{ branch: "feature", defaultBranch: "main", worktreePath: null, force: false },
			{ git },
		);
		expect(result).toBe("empty");
	});

	test("worktree + clean + ahead=0 → empty", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			commitCountMap: new Map([["main..feature", 0]]),
		});
		const result = await classifyGoneBranch(
			{ branch: "feature", defaultBranch: "main", worktreePath: "/wt/feature", force: false },
			{ git },
		);
		expect(result).toBe("empty");
	});

	test("no worktree + ahead>0 + cherry-picked-prefix covers all → merged", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			commitCountMap: new Map([["main..feature", 2]]),
			revListMap: new Map([["main..feature", ["sha1", "sha2"]]]),
			revListCherryPickMap: new Map([["main...feature", []]]),
		});
		const result = await classifyGoneBranch(
			{ branch: "feature", defaultBranch: "main", worktreePath: null, force: false },
			{ git },
		);
		expect(result).toBe("merged");
	});

	test("no worktree + ahead>0 + squash-prefix covers all → merged", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			commitCountMap: new Map([["main..feature", 2]]),
			revListMap: new Map([
				["main..feature", ["sha1", "sha2"]],
				["feature..main", ["squash-sha"]],
			]),
			revListCherryPickMap: new Map([["main...feature", ["sha1", "sha2"]]]),
			mergeBaseMap: new Map([["main:feature", "merge-base"]]),
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
		const result = await classifyGoneBranch(
			{ branch: "feature", defaultBranch: "main", worktreePath: null, force: false },
			{ git },
		);
		expect(result).toBe("merged");
	});

	test("no worktree + ahead>0 + no prefix matches → skipped-unmerged", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			commitCountMap: new Map([["main..feature", 2]]),
			revListMap: new Map([
				["main..feature", ["sha1", "sha2"]],
				["feature..main", []],
			]),
			revListCherryPickMap: new Map([["main...feature", ["sha1", "sha2"]]]),
			mergeBaseMap: new Map([["main:feature", "merge-base"]]),
		});
		const result = await classifyGoneBranch(
			{ branch: "feature", defaultBranch: "main", worktreePath: null, force: false },
			{ git },
		);
		expect(result).toBe("skipped-unmerged");
	});

	test("worktree + clean + ahead>0 + no prefix → skipped-unmerged", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			commitCountMap: new Map([["main..feature", 2]]),
			revListMap: new Map([
				["main..feature", ["sha1", "sha2"]],
				["feature..main", []],
			]),
			revListCherryPickMap: new Map([["main...feature", ["sha1", "sha2"]]]),
			mergeBaseMap: new Map([["main:feature", "merge-base"]]),
		});
		const result = await classifyGoneBranch(
			{ branch: "feature", defaultBranch: "main", worktreePath: "/wt/feature", force: false },
			{ git },
		);
		expect(result).toBe("skipped-unmerged");
	});

	test("force always → merged regardless of mergedness or dirtiness", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			commitCountMap: new Map([["main..feature", 5]]),
			dirtyWorktrees: new Set(["/wt/feature"]),
		});
		const result = await classifyGoneBranch(
			{ branch: "feature", defaultBranch: "main", worktreePath: "/wt/feature", force: true },
			{ git },
		);
		expect(result).toBe("merged");
	});
});
