import { describe, expect, test } from "bun:test";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { isFullyMerged } from "./is-fully-merged.ts";

describe("isFullyMerged", () => {
	test("ahead=0 → false (cannot prove merge without commits)", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			commitCountMap: new Map([["main..feature", 0]]),
		});
		const result = await isFullyMerged({ branch: "feature", defaultBranch: "main" }, { git });
		expect(result).toBe(false);
	});

	test("ahead lookup fails → false (be conservative)", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			// no commitCountMap entry — getCommitCount returns err
		});
		const result = await isFullyMerged({ branch: "feature", defaultBranch: "main" }, { git });
		expect(result).toBe(false);
	});

	test("ahead>0 + all commits cherry-picked → true", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			commitCountMap: new Map([["main..feature", 2]]),
			revListMap: new Map([["main..feature", ["sha1", "sha2"]]]),
			revListCherryPickMap: new Map([["main...feature", []]]),
		});
		const result = await isFullyMerged({ branch: "feature", defaultBranch: "main" }, { git });
		expect(result).toBe(true);
	});

	test("ahead>0 + all commits squash-merged → true", async () => {
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
		const result = await isFullyMerged({ branch: "feature", defaultBranch: "main" }, { git });
		expect(result).toBe(true);
	});

	test("ahead>0 + only partial cherry-pick coverage → false", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			commitCountMap: new Map([["main..feature", 2]]),
			revListMap: new Map([
				["main..feature", ["sha1", "sha2"]],
				["feature..main", []],
			]),
			// Only sha1 was cherry-picked (kept in filtered set ≠ excluded)
			revListCherryPickMap: new Map([["main...feature", ["sha1", "sha2"]]]),
			mergeBaseMap: new Map([["main:feature", "merge-base"]]),
		});
		const result = await isFullyMerged({ branch: "feature", defaultBranch: "main" }, { git });
		expect(result).toBe(false);
	});

	test("ahead>0 + no merge proof at all → false", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			commitCountMap: new Map([["main..feature", 3]]),
			revListMap: new Map([
				["main..feature", ["sha1", "sha2", "sha3"]],
				["feature..main", []],
			]),
			revListCherryPickMap: new Map([["main...feature", ["sha1", "sha2", "sha3"]]]),
			mergeBaseMap: new Map([["main:feature", "merge-base"]]),
		});
		const result = await isFullyMerged({ branch: "feature", defaultBranch: "main" }, { git });
		expect(result).toBe(false);
	});
});
