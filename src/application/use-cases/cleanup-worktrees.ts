import type { GitPort } from "../../domain/ports/git-port.ts";
import { Result as R, type Result } from "../../shared/result.ts";

export interface CleanupWorktreesInput {
	force: boolean;
	dryRun: boolean;
}

export type CleanupBranchStatus =
	| { status: "cleaned" }
	| { status: "branch-only" }
	| { status: "skipped-unmerged" }
	| { status: "skipped-dirty" }
	| { status: "dry-run" }
	| { status: "error"; message: string };

export interface CleanupBranchReport {
	branch: string;
	worktreePath: string | null;
	result: CleanupBranchStatus;
}

export interface CleanupWorktreesOutput {
	reports: CleanupBranchReport[];
}

export interface CleanupWorktreesDeps {
	git: GitPort;
}

export async function cleanupWorktrees(
	input: CleanupWorktreesInput,
	deps: CleanupWorktreesDeps,
): Promise<Result<CleanupWorktreesOutput, Error>> {
	const { git } = deps;

	const fetchResult = await git.fetchPrune();
	if (!fetchResult.success) {
		return R.err(new Error(`Fetch failed: ${fetchResult.error.message}`));
	}

	const goneBranchesResult = await git.listGoneBranches();
	if (!goneBranchesResult.success) {
		return R.err(new Error(goneBranchesResult.error.message));
	}
	const goneBranches = goneBranchesResult.data;

	if (goneBranches.length === 0) {
		return R.ok({ reports: [] });
	}

	const defaultBranchResult = await git.getDefaultBranch();
	if (!defaultBranchResult.success) {
		return R.err(new Error(defaultBranchResult.error.message));
	}
	const defaultBranch = defaultBranchResult.data;

	const worktreesResult = await git.listWorktrees();
	if (!worktreesResult.success) {
		return R.err(new Error(worktreesResult.error.message));
	}
	const worktreeByBranch = new Map(worktreesResult.data.map((w) => [w.branch, w]));

	const reports: CleanupBranchReport[] = [];

	for (const branch of goneBranches) {
		if (branch === defaultBranch) {
			continue;
		}

		const worktree = worktreeByBranch.get(branch);
		const worktreePath = worktree?.path ?? null;

		if (input.dryRun) {
			reports.push({ branch, worktreePath, result: { status: "dry-run" } });
			continue;
		}

		if (worktree) {
			const dirtyResult = await git.isDirty(worktree.path);
			if (dirtyResult.success && dirtyResult.data && !input.force) {
				reports.push({ branch, worktreePath, result: { status: "skipped-dirty" } });
				continue;
			}

			const removeResult = await git.removeWorktree(worktree.path);
			if (!removeResult.success) {
				reports.push({
					branch,
					worktreePath,
					result: { status: "error", message: `Failed to remove worktree: ${removeResult.error.message}` },
				});
				continue;
			}
		}

		const deleteResult = await git.deleteBranch(branch);

		if (!deleteResult.success) {
			if (deleteResult.error.code === "BRANCH_NOT_MERGED") {
				if (input.force) {
					const forceResult = await git.deleteBranchForce(branch);
					if (!forceResult.success) {
						reports.push({
							branch,
							worktreePath,
							result: { status: "error", message: forceResult.error.message },
						});
						continue;
					}
				} else {
					reports.push({ branch, worktreePath, result: { status: "skipped-unmerged" } });
					continue;
				}
			} else {
				reports.push({
					branch,
					worktreePath,
					result: { status: "error", message: deleteResult.error.message },
				});
				continue;
			}
		}

		reports.push({
			branch,
			worktreePath,
			result: { status: worktree ? "cleaned" : "branch-only" },
		});
	}

	return R.ok({ reports });
}
