import { describe, expect, test } from "bun:test";
import type { Worktree } from "../domain/entities/worktree.ts";
import { getExpectedWorktreePath, isDrifted } from "./worktree-drift.ts";

const ROOT = "/fake/project";
const ROOT_DIR = ".worktrees";

function wt(overrides: Partial<Worktree> = {}): Worktree {
	return {
		path: `${ROOT}/${ROOT_DIR}/feature`,
		branch: "feature",
		head: "abc1234",
		isMain: false,
		isPrunable: false,
		...overrides,
	};
}

describe("getExpectedWorktreePath", () => {
	test("joins repoRoot, rootDir and branch", () => {
		expect(getExpectedWorktreePath(ROOT, ".worktrees", "feature")).toBe(`${ROOT}/.worktrees/feature`);
	});

	test("absolute rootDir overrides repoRoot", () => {
		expect(getExpectedWorktreePath(ROOT, "/abs/worktrees", "feature")).toBe("/abs/worktrees/feature");
	});
});

describe("isDrifted", () => {
	test("returns false when path matches expected", () => {
		expect(isDrifted(wt(), ROOT, ROOT_DIR)).toBe(false);
	});

	test("returns true when dir name differs from branch", () => {
		expect(isDrifted(wt({ path: `${ROOT}/${ROOT_DIR}/old-name` }), ROOT, ROOT_DIR)).toBe(true);
	});

	test("returns true when worktree lives outside rootDir", () => {
		expect(isDrifted(wt({ path: "/somewhere/else/feature" }), ROOT, ROOT_DIR)).toBe(true);
	});

	test("returns false for the main worktree", () => {
		expect(isDrifted(wt({ path: ROOT, branch: "main", isMain: true }), ROOT, ROOT_DIR)).toBe(false);
	});

	test("returns false for a branchless worktree", () => {
		expect(isDrifted(wt({ path: "/anywhere", branch: "" }), ROOT, ROOT_DIR)).toBe(false);
	});

	test("handles nested branch names", () => {
		const path = `${ROOT}/${ROOT_DIR}/feat/my-feature`;
		expect(isDrifted(wt({ path, branch: "feat/my-feature" }), ROOT, ROOT_DIR)).toBe(false);
		expect(isDrifted(wt({ path: `${ROOT}/${ROOT_DIR}/feat/other`, branch: "feat/my-feature" }), ROOT, ROOT_DIR)).toBe(
			true,
		);
	});
});
