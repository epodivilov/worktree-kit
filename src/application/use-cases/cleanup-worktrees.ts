import type { GitPort } from "../../domain/ports/git-port.ts";
import { Result as R, type Result } from "../../shared/result.ts";

export interface CleanupWorktreesInput {
	force: boolean;
	dryRun: boolean;
	skipFetch?: boolean;
	skipOrphans?: boolean;
}

export type CleanupBranchStatus =
	| { status: "cleaned" }
	| { status: "branch-only" }
	| { status: "skipped-unmerged" }
	| { status: "skipped-dirty" }
	| { status: "dry-run" }
	| { status: "orphan-cleaned" }
	| { status: "orphan-skipped-dirty" }
	| { status: "orphan-dry-run" }
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

	if (!input.skipFetch) {
		const fetchResult = await git.fetchPrune();
		if (!fetchResult.success) {
			return R.err(new Error(`Fetch failed: ${fetchResult.error.message}`));
		}
	}

	const goneBranchesResult = await git.listGoneBranches();
	if (!goneBranchesResult.success) {
		return R.err(new Error(goneBranchesResult.error.message));
	}
	const goneBranches = goneBranchesResult.data;

	const reports: CleanupBranchReport[] = [];

	if (goneBranches.length > 0) {
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

				const removeResult = await git.removeWorktree(worktree.path, { force: input.force });
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
					const commitsAhead = await git.getCommitCount(defaultBranch, branch);
					const hasUniqueCommits = !commitsAhead.success || commitsAhead.data > 0;

					if (hasUniqueCommits && !input.force) {
						reports.push({ branch, worktreePath, result: { status: "skipped-unmerged" } });
						continue;
					}

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
	}

	// Second pass: detect orphaned worktrees (branch no longer exists locally)
	const remainingResult = input.skipOrphans ? null : await git.listWorktrees();
	if (remainingResult?.success) {
		for (const worktree of remainingResult.data) {
			if (worktree.isMain) continue;

			if (worktree.branch) {
				const exists = await git.branchExists(worktree.branch);
				if (!exists.success || exists.data) continue;
			}

			if (input.dryRun) {
				reports.push({
					branch: worktree.branch,
					worktreePath: worktree.path,
					result: { status: "orphan-dry-run" },
				});
				continue;
			}

			const dirtyResult = await git.isDirty(worktree.path);
			if (dirtyResult.success && dirtyResult.data && !input.force) {
				reports.push({
					branch: worktree.branch,
					worktreePath: worktree.path,
					result: { status: "orphan-skipped-dirty" },
				});
				continue;
			}

			const removeResult = await git.removeWorktree(worktree.path, { force: input.force });
			if (!removeResult.success) {
				reports.push({
					branch: worktree.branch,
					worktreePath: worktree.path,
					result: { status: "error", message: `Failed to remove orphaned worktree: ${removeResult.error.message}` },
				});
				continue;
			}

			reports.push({
				branch: worktree.branch,
				worktreePath: worktree.path,
				result: { status: "orphan-cleaned" },
			});
		}
	}

	return R.ok({ reports });
}
