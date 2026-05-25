import { describe, expect, test } from "bun:test";
import type { Worktree } from "../../domain/entities/worktree.ts";
import { formatWorktreeLine, toListItem } from "./list.ts";

const ROOT = "/fake/project";
const ROOT_DIR = ".worktrees";
const DRIFT = { repoRoot: ROOT, rootDir: ROOT_DIR };

const mainWt: Worktree = { path: ROOT, branch: "main", head: "aaa", isMain: true, isPrunable: false };
const alignedWt: Worktree = {
	path: `${ROOT}/${ROOT_DIR}/feature`,
	branch: "feature",
	head: "bbb",
	isMain: false,
	isPrunable: false,
};
const driftedWt: Worktree = {
	path: `${ROOT}/${ROOT_DIR}/old-name`,
	branch: "renamed",
	head: "ccc",
	isMain: false,
	isPrunable: false,
};

describe("toListItem", () => {
	test("marks drifted: true when dir name differs from branch", () => {
		expect(toListItem(driftedWt, null, DRIFT).drifted).toBe(true);
	});

	test("marks drifted: false when dir matches branch", () => {
		expect(toListItem(alignedWt, null, DRIFT).drifted).toBe(false);
	});

	test("main worktree is never drifted", () => {
		expect(toListItem(mainWt, null, DRIFT).drifted).toBe(false);
	});

	test("drifted defaults to false when no drift context (config missing)", () => {
		expect(toListItem(driftedWt, null, null).drifted).toBe(false);
	});

	test("sets isCurrent based on currentPath", () => {
		expect(toListItem(alignedWt, alignedWt.path, DRIFT).isCurrent).toBe(true);
		expect(toListItem(alignedWt, ROOT, DRIFT).isCurrent).toBe(false);
	});
});

describe("formatWorktreeLine", () => {
	test("appends drift marker for drifted worktrees", () => {
		expect(formatWorktreeLine(driftedWt, null, DRIFT)).toContain("⚠ dir≠branch");
	});

	test("omits drift marker for aligned worktrees", () => {
		expect(formatWorktreeLine(alignedWt, null, DRIFT)).not.toContain("dir≠branch");
	});

	test("omits drift marker when no drift context", () => {
		expect(formatWorktreeLine(driftedWt, null, null)).not.toContain("dir≠branch");
	});
});
