import { describe, expect, test } from "bun:test";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { findSquashMergedPrefix } from "./find-squash-merged-prefix.ts";

describe("findSquashMergedPrefix", () => {
	test("full squash (all feature commits) returns null — let plain rebase surface the conflict", async () => {
		// All feature commits would be skipped → rebase --onto would silently reset feature to base.
		// Filter declines so the user can react instead of having local commits silently discarded.
		const git = createFakeGit({
			revListMap: new Map([
				["base..feature", ["f2", "f1"]],
				["feature..base", ["S", "older"]],
			]),
			mergeBaseMap: new Map([["base:feature", "M"]]),
			diffTreeFilesMap: new Map([
				["f1", ["a.ts"]],
				["f2", ["b.ts"]],
				["S", ["a.ts", "b.ts"]],
				["older", ["unrelated.ts"]],
			]),
			diffNormalizedMap: new Map([
				["M..f2", "DIFF_AB"],
				["S^..S", "DIFF_AB"],
			]),
		});

		const result = await findSquashMergedPrefix({ git }, { base: "base", feature: "feature" });

		expect(result).toBeNull();
	});

	test("partial squash prefix: only first commit was squashed", async () => {
		// feature: f1 (squashed) -> f2 (still pending) -> f3 (still pending)
		// rev-list base..feature → [f3, f2, f1]; reversed for processing: [f1, f2, f3]
		const git = createFakeGit({
			revListMap: new Map([
				["base..feature", ["f3", "f2", "f1"]],
				["feature..base", ["S"]],
			]),
			mergeBaseMap: new Map([["base:feature", "M"]]),
			diffTreeFilesMap: new Map([
				["f1", ["a.ts"]],
				["f2", ["b.ts"]],
				["f3", ["c.ts"]],
				["S", ["a.ts"]],
			]),
			diffNormalizedMap: new Map([
				["M..f1", "DIFF_A"],
				["S^..S", "DIFF_A"],
			]),
		});

		const result = await findSquashMergedPrefix({ git }, { base: "base", feature: "feature" });

		expect(result).toEqual({
			lastSkippedCommit: "f1",
			skippedCount: 1,
			totalCount: 3,
			method: "squash",
		});
	});

	test("fingerprint match but different diff content is rejected", async () => {
		const git = createFakeGit({
			revListMap: new Map([
				["base..feature", ["f1"]],
				["feature..base", ["S"]],
			]),
			mergeBaseMap: new Map([["base:feature", "M"]]),
			diffTreeFilesMap: new Map([
				["f1", ["a.ts"]],
				["S", ["a.ts"]],
			]),
			diffNormalizedMap: new Map([
				["M..f1", "DIFF_FEATURE"],
				["S^..S", "DIFF_OTHER"],
			]),
		});

		const result = await findSquashMergedPrefix({ git }, { base: "base", feature: "feature" });

		expect(result).toBeNull();
	});

	test("no candidates with matching fingerprint returns null", async () => {
		const git = createFakeGit({
			revListMap: new Map([
				["base..feature", ["f1"]],
				["feature..base", ["other"]],
			]),
			mergeBaseMap: new Map([["base:feature", "M"]]),
			diffTreeFilesMap: new Map([
				["f1", ["a.ts"]],
				["other", ["unrelated.ts"]],
			]),
		});

		const result = await findSquashMergedPrefix({ git }, { base: "base", feature: "feature" });

		expect(result).toBeNull();
	});

	test("scans at most 100 base commits", async () => {
		// feature has 2 commits so a prefix of length 1 can match (partial prefix, not full range)
		// 101 candidates, the match is at position 100 (0-indexed) → out of cap
		const candidates = Array.from({ length: 101 }, (_, i) => `c${i}`);
		const diffTree = new Map<string, string[]>([
			["f1", ["a.ts"]],
			["f2", ["b.ts"]],
		]);
		for (const c of candidates) diffTree.set(c, ["unrelated.ts"]);
		// the matching candidate is at index 100 (101st), past the cap
		diffTree.set("c100", ["a.ts"]);

		const git = createFakeGit({
			revListMap: new Map([
				["base..feature", ["f2", "f1"]],
				["feature..base", candidates],
			]),
			mergeBaseMap: new Map([["base:feature", "M"]]),
			diffTreeFilesMap: diffTree,
			diffNormalizedMap: new Map([
				["M..f1", "DIFF_A"],
				["c100^..c100", "DIFF_A"],
			]),
		});

		const result = await findSquashMergedPrefix({ git }, { base: "base", feature: "feature" });

		expect(result).toBeNull();
	});

	test("empty feature range returns null", async () => {
		const git = createFakeGit({
			revListMap: new Map([["base..feature", []]]),
		});

		const result = await findSquashMergedPrefix({ git }, { base: "base", feature: "feature" });

		expect(result).toBeNull();
	});
});
