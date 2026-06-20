import type { GitPort } from "../../domain/ports/git-port.ts";
import { Result as R, type Result } from "../../shared/result.ts";
import { classifyGoneBranch } from "./classify-gone-branch.ts";
import { deleteBranch } from "./delete-branch.ts";
import { isFullyMerged } from "./is-fully-merged.ts";

export interface CleanupWorktreesInput {
	force: boolean;
	dryRun: boolean;
	skipFetch?: boolean;
	skipOrphans?: boolean;
	/** Allow-list: when set, only these branches are processed (empty list = none). */
	branches?: readonly string[];
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
	const processedBranches = new Set<string>();

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
	const allowList = input.branches ? new Set(input.branches) : null;

	const removeBranchAndWorktree = async (branch: string, worktree: { path: string } | undefined): Promise<void> => {
		const worktreePath = worktree?.path ?? null;
		if (worktree) {
			const removeResult = await git.removeWorktree(worktree.path, { force: input.force });
			if (!removeResult.success) {
				reports.push({
					branch,
					worktreePath,
					result: { status: "error", message: `Failed to remove worktree: ${removeResult.error.message}` },
				});
				return;
			}
		}

		const outcome = await deleteBranch({ branch, force: true, deleteRemote: false }, { git });
		if (outcome.status === "failed") {
			reports.push({
				branch,
				worktreePath,
				result: { status: "error", message: outcome.message },
			});
			return;
		}

		reports.push({
			branch,
			worktreePath,
			result: { status: worktree ? "cleaned" : "branch-only" },
		});
	};

	if (goneBranches.length > 0) {
		for (const branch of goneBranches) {
			if (branch === defaultBranch) {
				continue;
			}

			if (allowList && !allowList.has(branch)) {
				continue;
			}

			processedBranches.add(branch);
			const worktree = worktreeByBranch.get(branch);
			const worktreePath = worktree?.path ?? null;

			// Classify before the dry-run gate so the preview predicts the real outcome.
			const classification = await classifyGoneBranch(
				{ branch, defaultBranch, worktreePath, force: input.force },
				{ git },
			);

			if (classification === "skipped-dirty") {
				reports.push({ branch, worktreePath, result: { status: "skipped-dirty" } });
				continue;
			}

			if (classification === "skipped-unmerged") {
				reports.push({ branch, worktreePath, result: { status: "skipped-unmerged" } });
				continue;
			}

			// "merged" and "empty" both proceed to removal in cleanup.
			if (input.dryRun) {
				reports.push({ branch, worktreePath, result: { status: "dry-run" } });
				continue;
			}

			await removeBranchAndWorktree(branch, worktree);
		}
	}

	// Second pass: branches with an active worktree whose remote is still alive
	// (no [gone] marker) but every commit ahead of default is already in default
	// via cherry-pick or squash-merge. Catches squash-merged PRs when GitHub's
	// auto-delete-on-merge is disabled.
	for (const worktree of worktreesResult.data) {
		if (worktree.isMain) continue;
		if (!worktree.branch) continue;
		if (worktree.branch === defaultBranch) continue;
		if (processedBranches.has(worktree.branch)) continue;

		const branch = worktree.branch;

		if (allowList && !allowList.has(branch)) continue;

		const merged = await isFullyMerged({ branch, defaultBranch }, { git });
		if (!merged) continue;

		if (input.dryRun) {
			reports.push({ branch, worktreePath: worktree.path, result: { status: "dry-run" } });
			continue;
		}

		if (!input.force) {
			const dirty = await git.isDirty(worktree.path);
			if (dirty.success && dirty.data === true) {
				reports.push({ branch, worktreePath: worktree.path, result: { status: "skipped-dirty" } });
				continue;
			}
		}

		await removeBranchAndWorktree(branch, worktree);
	}

	// Third pass: detect orphaned worktrees (branch no longer exists locally)
	const remainingResult = input.skipOrphans ? null : await git.listWorktrees();
	if (remainingResult?.success) {
		for (const worktree of remainingResult.data) {
			if (worktree.isMain) continue;

			if (worktree.branch) {
				const exists = await git.branchExists(worktree.branch);
				if (!exists.success || exists.data) continue;
			}

			// Check dirtiness before the dry-run gate so the preview predicts the real outcome.
			const dirtyResult = await git.isDirty(worktree.path);
			if (dirtyResult.success && dirtyResult.data && !input.force) {
				reports.push({
					branch: worktree.branch,
					worktreePath: worktree.path,
					result: { status: "orphan-skipped-dirty" },
				});
				continue;
			}

			if (input.dryRun) {
				reports.push({
					branch: worktree.branch,
					worktreePath: worktree.path,
					result: { status: "orphan-dry-run" },
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
