import { describe, expect, test } from "bun:test";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { findCherryPickedPrefix } from "./find-cherry-picked-prefix.ts";

describe("findCherryPickedPrefix", () => {
	test("patch-id: returns prefix of cherry-picked commits", async () => {
		// feature has 4 commits: f1 (oldest) — f2 — f3 — f4 (newest)
		// f1, f2 already on base via patch-id (rebased parent prefix)
		// rev-list base..feature is reverse-chronological: [f4, f3, f2, f1]
		// rev-list --cherry-pick --right-only base...feature returns commits NOT on base: [f4, f3]
		const git = createFakeGit({
			revListMap: new Map([["base..feature", ["f4", "f3", "f2", "f1"]]]),
			revListCherryPickMap: new Map([["base...feature", ["f4", "f3"]]]),
		});

		const result = await findCherryPickedPrefix({ git }, { base: "base", feature: "feature" });

		expect(result).toEqual({
			lastSkippedCommit: "f2",
			skippedCount: 2,
			totalCount: 4,
			method: "patch-id",
		});
	});

	test("subject+files fallback: matches when patch-ids diverge", async () => {
		// patch-id sees nothing as cherry-picked (filtered === full),
		// fallback uses subject + diff-tree file equality
		const git = createFakeGit({
			revListMap: new Map([["base..feature", ["f3", "f2", "f1"]]]),
			revListCherryPickMap: new Map([["base...feature", ["f3", "f2", "f1"]]]),
			logSubjectsMap: new Map([
				[
					"base..feature",
					[
						{ sha: "f3", subject: "feat: new" },
						{ sha: "f2", subject: "feat: B" },
						{ sha: "f1", subject: "feat: A" },
					],
				],
				[
					"feature..base",
					[
						{ sha: "b2", subject: "feat: B" },
						{ sha: "b1", subject: "feat: A" },
					],
				],
			]),
			diffTreeFilesMap: new Map([
				["f1", ["a.ts"]],
				["f2", ["b.ts"]],
				["f3", ["c.ts"]],
				["b1", ["a.ts"]],
				["b2", ["b.ts"]],
			]),
		});

		const result = await findCherryPickedPrefix({ git }, { base: "base", feature: "feature" });

		expect(result).toEqual({
			lastSkippedCommit: "f2",
			skippedCount: 2,
			totalCount: 3,
			method: "subject",
		});
	});

	test("subject-only match with different files is rejected", async () => {
		// f1 has same subject as b1 but different files — not a match
		const git = createFakeGit({
			revListMap: new Map([["base..feature", ["f2", "f1"]]]),
			revListCherryPickMap: new Map([["base...feature", ["f2", "f1"]]]),
			logSubjectsMap: new Map([
				[
					"base..feature",
					[
						{ sha: "f2", subject: "feat: new" },
						{ sha: "f1", subject: "fix: shared" },
					],
				],
				["feature..base", [{ sha: "b1", subject: "fix: shared" }]],
			]),
			diffTreeFilesMap: new Map([
				["f1", ["foo.ts"]],
				["f2", ["bar.ts"]],
				["b1", ["different.ts"]],
			]),
		});

		const result = await findCherryPickedPrefix({ git }, { base: "base", feature: "feature" });

		expect(result).toBeNull();
	});

	test("empty range returns null", async () => {
		const git = createFakeGit({
			revListMap: new Map([["base..feature", []]]),
		});

		const result = await findCherryPickedPrefix({ git }, { base: "base", feature: "feature" });

		expect(result).toBeNull();
	});

	test("full overlap returns null", async () => {
		// All commits cherry-picked → would rebase to nothing; treat as no-op
		const git = createFakeGit({
			revListMap: new Map([["base..feature", ["f2", "f1"]]]),
			revListCherryPickMap: new Map([["base...feature", []]]),
			logSubjectsMap: new Map([
				[
					"base..feature",
					[
						{ sha: "f2", subject: "feat: B" },
						{ sha: "f1", subject: "feat: A" },
					],
				],
				["feature..base", []],
			]),
		});

		const result = await findCherryPickedPrefix({ git }, { base: "base", feature: "feature" });

		expect(result).toBeNull();
	});

	test("no cherry-picked commits returns null", async () => {
		const git = createFakeGit({
			revListMap: new Map([["base..feature", ["f2", "f1"]]]),
			revListCherryPickMap: new Map([["base...feature", ["f2", "f1"]]]),
			logSubjectsMap: new Map([
				[
					"base..feature",
					[
						{ sha: "f2", subject: "feat: B" },
						{ sha: "f1", subject: "feat: A" },
					],
				],
				["feature..base", []],
			]),
		});

		const result = await findCherryPickedPrefix({ git }, { base: "base", feature: "feature" });

		expect(result).toBeNull();
	});
});
