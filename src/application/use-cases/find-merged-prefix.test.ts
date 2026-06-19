import { describe, expect, test } from "bun:test";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { findMergedPrefix } from "./find-merged-prefix.ts";

describe("findMergedPrefix", () => {
	test("no commits ahead of base → null", async () => {
		const git = createFakeGit({
			revListMap: new Map([["base..feature", []]]),
		});
		const result = await findMergedPrefix({ git }, { base: "base", feature: "feature" });
		expect(result).toBeNull();
	});

	test("cherry-pick (patch-id): fully merged → fully=true with full counts", async () => {
		// All 2 commits filtered out by cherry-pick — fully merged via patch-id.
		const git = createFakeGit({
			revListMap: new Map([["base..feature", ["f2", "f1"]]]),
			revListCherryPickMap: new Map([["base...feature", []]]),
		});
		const result = await findMergedPrefix({ git }, { base: "base", feature: "feature" });
		expect(result).toEqual({
			lastSkippedCommit: "f2",
			skippedCount: 2,
			totalCount: 2,
			fully: true,
			method: "patch-id",
		});
	});

	test("cherry-pick (patch-id): partial prefix → fully=false, lastSkippedCommit usable as rebase upstream", async () => {
		// f1, f2 already on base; f3, f4 still ahead.
		const git = createFakeGit({
			revListMap: new Map([["base..feature", ["f4", "f3", "f2", "f1"]]]),
			revListCherryPickMap: new Map([["base...feature", ["f4", "f3"]]]),
		});
		const result = await findMergedPrefix({ git }, { base: "base", feature: "feature" });
		expect(result).toEqual({
			lastSkippedCommit: "f2",
			skippedCount: 2,
			totalCount: 4,
			fully: false,
			method: "patch-id",
		});
	});

	test("squash fallback: kicks in only when cherry-pick returns null", async () => {
		// revListCherryPick equals fullCommits → patch-id skips; logSubjects has no overlap → subject also skips
		// → cherryPickPrefix is null, squash detection runs and finds a full squash match.
		const git = createFakeGit({
			revListMap: new Map([
				["base..feature", ["f2", "f1"]],
				["feature..base", ["S"]],
			]),
			revListCherryPickMap: new Map([["base...feature", ["f2", "f1"]]]),
			logSubjectsMap: new Map([
				[
					"base..feature",
					[
						{ sha: "f2", subject: "feat: B" },
						{ sha: "f1", subject: "feat: A" },
					],
				],
				["feature..base", [{ sha: "S", subject: "feat: squash" }]],
			]),
			mergeBaseMap: new Map([["base:feature", "MB"]]),
			diffTreeFilesMap: new Map([
				["f1", ["a.ts"]],
				["f2", ["b.ts"]],
				["S", ["a.ts", "b.ts"]],
			]),
			diffNormalizedMap: new Map([
				["MB..f2", "DIFF_AB"],
				["S^..S", "DIFF_AB"],
			]),
		});
		const result = await findMergedPrefix({ git }, { base: "base", feature: "feature" });
		expect(result).toMatchObject({
			lastSkippedCommit: "f2",
			skippedCount: 2,
			totalCount: 2,
			fully: true,
			method: "squash",
		});
	});

	test("cherry-pick partial prefix wins over squash fallback (no squash call)", async () => {
		// cherry-pick returns a partial prefix → squash detection should NOT run.
		// If squash detection ran, it would have no fixture data and might fail or return null;
		// either way, the cherry-pick partial prefix takes precedence.
		const git = createFakeGit({
			revListMap: new Map([["base..feature", ["f4", "f3", "f2", "f1"]]]),
			revListCherryPickMap: new Map([["base...feature", ["f4", "f3"]]]),
		});
		const result = await findMergedPrefix({ git }, { base: "base", feature: "feature" });
		expect(result).toMatchObject({
			method: "patch-id",
			fully: false,
			skippedCount: 2,
			totalCount: 4,
		});
	});

	test("partial cherry-pick + full squash: option toggles which result wins", async () => {
		// Scenario: cherry-pick detects 2 of 5 commits (patch-id matched the tail), but a squash
		// of all 5 also landed on base. Each call site needs a different answer:
		//   - update-worktrees wants the cherry-pick partial (rebase --upstream boundary)
		//   - is-fully-merged wants the squash full (proof the branch is entirely covered)
		const git = createFakeGit({
			revListMap: new Map([
				// base..feature: 5 commits (newest first)
				["base..feature", ["f5", "f4", "f3", "f2", "f1"]],
				// feature..base: one squash commit on base
				["feature..base", ["S"]],
			]),
			// cherry-pick filter keeps f5, f4, f3 ahead → tail f2, f1 are the "skipped prefix" (2 of 5)
			revListCherryPickMap: new Map([["base...feature", ["f5", "f4", "f3"]]]),
			// Squash detection needs file fingerprints + diff equality.
			// Cumulative files prefix-by-prefix: f1={a}, f1+f2={a,b}, f1+f2+f3={a,b,c},
			// f1+f2+f3+f4={a,b,c,d}, f1+f2+f3+f4+f5={a,b,c,d,e}. The squash S touches all 5.
			mergeBaseMap: new Map([["base:feature", "MB"]]),
			diffTreeFilesMap: new Map([
				["f1", ["a"]],
				["f2", ["b"]],
				["f3", ["c"]],
				["f4", ["d"]],
				["f5", ["e"]],
				["S", ["a", "b", "c", "d", "e"]],
			]),
			diffNormalizedMap: new Map([
				// Squash diff equals the full-prefix diff (mergeBase..f5), so squash detection
				// returns skippedCount=5, totalCount=5.
				["MB..f5", "DIFF_FULL"],
				["S^..S", "DIFF_FULL"],
			]),
		});

		const rich = await findMergedPrefix(
			{ git },
			{ base: "base", feature: "feature" },
			{ trySquashOnPartialCherryPick: true },
		);
		expect(rich).toEqual({
			lastSkippedCommit: "f5",
			skippedCount: 5,
			totalCount: 5,
			fully: true,
			method: "squash",
		});

		const simple = await findMergedPrefix(
			{ git },
			{ base: "base", feature: "feature" },
			{ trySquashOnPartialCherryPick: false },
		);
		expect(simple).toEqual({
			lastSkippedCommit: "f2",
			skippedCount: 2,
			totalCount: 5,
			fully: false,
			method: "patch-id",
		});
	});

	test("no cherry-pick, no squash match → null", async () => {
		const git = createFakeGit({
			revListMap: new Map([
				["base..feature", ["f1"]],
				["feature..base", []],
			]),
			revListCherryPickMap: new Map([["base...feature", ["f1"]]]),
			logSubjectsMap: new Map([
				["base..feature", [{ sha: "f1", subject: "new" }]],
				["feature..base", []],
			]),
			diffTreeFilesMap: new Map([["f1", ["a.ts"]]]),
		});
		const result = await findMergedPrefix({ git }, { base: "base", feature: "feature" });
		expect(result).toBeNull();
	});
});
