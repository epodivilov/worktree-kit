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
