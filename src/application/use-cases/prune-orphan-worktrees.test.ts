import { describe, expect, test } from "bun:test";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { pruneOrphanWorktrees } from "./prune-orphan-worktrees.ts";

describe("pruneOrphanWorktrees", () => {
	test("empty paths — empty reports", async () => {
		const git = createFakeGit();
		const output = await pruneOrphanWorktrees({ paths: [] }, { git });
		expect(output.reports).toHaveLength(0);
	});

	test("all paths prune successfully", async () => {
		const pruneCalls: string[] = [];
		const git = createFakeGit({ pruneCalls });
		const output = await pruneOrphanWorktrees({ paths: ["/wt/orphan-a", "/wt/orphan-b"] }, { git });

		expect(output.reports).toHaveLength(2);
		expect(output.reports[0]).toEqual({ worktreePath: "/wt/orphan-a", status: "pruned" });
		expect(output.reports[1]).toEqual({ worktreePath: "/wt/orphan-b", status: "pruned" });
		expect(pruneCalls).toEqual(["/wt/orphan-a", "/wt/orphan-b"]);
	});

	test("one path fails — others still succeed", async () => {
		const git = createFakeGit({
			pruneFailPaths: new Map([["/wt/bad", "permission denied"]]),
		});
		const output = await pruneOrphanWorktrees({ paths: ["/wt/ok-a", "/wt/bad", "/wt/ok-b"] }, { git });

		expect(output.reports).toHaveLength(3);
		expect(output.reports[0]).toEqual({ worktreePath: "/wt/ok-a", status: "pruned" });
		expect(output.reports[1]).toEqual({
			worktreePath: "/wt/bad",
			status: "error",
			message: "permission denied",
		});
		expect(output.reports[2]).toEqual({ worktreePath: "/wt/ok-b", status: "pruned" });
	});

	test("dryRun — no prune calls, all reports are dry-run", async () => {
		const pruneCalls: string[] = [];
		const git = createFakeGit({ pruneCalls });
		const output = await pruneOrphanWorktrees({ paths: ["/wt/a", "/wt/b"], dryRun: true }, { git });

		expect(output.reports).toEqual([
			{ worktreePath: "/wt/a", status: "dry-run" },
			{ worktreePath: "/wt/b", status: "dry-run" },
		]);
		expect(pruneCalls).toEqual([]);
	});
});
