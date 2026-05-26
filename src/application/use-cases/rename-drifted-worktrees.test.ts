import { describe, expect, test } from "bun:test";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { renameDriftedWorktrees } from "./rename-drifted-worktrees.ts";

describe("renameDriftedWorktrees", () => {
	test("empty moves — empty reports", async () => {
		const git = createFakeGit();
		const output = await renameDriftedWorktrees({ moves: [] }, { git });
		expect(output.reports).toHaveLength(0);
	});

	test("all moves rename successfully", async () => {
		const moveCalls: { from: string; to: string }[] = [];
		const git = createFakeGit({
			moveCalls,
			worktrees: [
				{ path: "/wt/old-a", branch: "a", head: "h1", isMain: false, isPrunable: false },
				{ path: "/wt/old-b", branch: "b", head: "h2", isMain: false, isPrunable: false },
			],
		});
		const output = await renameDriftedWorktrees(
			{
				moves: [
					{ from: "/wt/old-a", to: "/wt/a", branch: "a" },
					{ from: "/wt/old-b", to: "/wt/b", branch: "b" },
				],
			},
			{ git },
		);

		expect(output.reports).toEqual([
			{ from: "/wt/old-a", to: "/wt/a", branch: "a", status: "renamed" },
			{ from: "/wt/old-b", to: "/wt/b", branch: "b", status: "renamed" },
		]);
		expect(moveCalls).toEqual([
			{ from: "/wt/old-a", to: "/wt/a" },
			{ from: "/wt/old-b", to: "/wt/b" },
		]);
	});

	test("locked worktree fails — others still succeed", async () => {
		const git = createFakeGit({
			moveFailPaths: new Map([["/wt/locked", { code: "WORKTREE_LOCKED", message: "needs review" }]]),
			worktrees: [
				{ path: "/wt/ok", branch: "ok", head: "h1", isMain: false, isPrunable: false },
				{ path: "/wt/locked", branch: "locked", head: "h2", isMain: false, isPrunable: false },
			],
		});
		const output = await renameDriftedWorktrees(
			{
				moves: [
					{ from: "/wt/ok", to: "/wt/ok-new", branch: "ok" },
					{ from: "/wt/locked", to: "/wt/locked-new", branch: "locked" },
				],
			},
			{ git },
		);

		expect(output.reports).toEqual([
			{ from: "/wt/ok", to: "/wt/ok-new", branch: "ok", status: "renamed" },
			{
				from: "/wt/locked",
				to: "/wt/locked-new",
				branch: "locked",
				status: "error",
				message: "needs review",
			},
		]);
	});

	test("destination already exists — reported as error", async () => {
		const git = createFakeGit({
			moveFailPaths: new Map([
				["/wt/old", { code: "WORKTREE_EXISTS", message: "destination '/wt/new' already exists" }],
			]),
			worktrees: [{ path: "/wt/old", branch: "feat", head: "h1", isMain: false, isPrunable: false }],
		});
		const output = await renameDriftedWorktrees(
			{ moves: [{ from: "/wt/old", to: "/wt/new", branch: "feat" }] },
			{ git },
		);

		expect(output.reports).toEqual([
			{
				from: "/wt/old",
				to: "/wt/new",
				branch: "feat",
				status: "error",
				message: "destination '/wt/new' already exists",
			},
		]);
	});

	test("dryRun — no move calls, all reports are dry-run", async () => {
		const moveCalls: { from: string; to: string }[] = [];
		const git = createFakeGit({ moveCalls });
		const output = await renameDriftedWorktrees(
			{
				moves: [
					{ from: "/wt/old-a", to: "/wt/a", branch: "a" },
					{ from: "/wt/old-b", to: "/wt/b", branch: "b" },
				],
				dryRun: true,
			},
			{ git },
		);

		expect(output.reports).toEqual([
			{ from: "/wt/old-a", to: "/wt/a", branch: "a", status: "dry-run" },
			{ from: "/wt/old-b", to: "/wt/b", branch: "b", status: "dry-run" },
		]);
		expect(moveCalls).toEqual([]);
	});
});
