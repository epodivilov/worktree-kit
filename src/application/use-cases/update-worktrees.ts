import type { GitPort } from "../../domain/ports/git-port.ts";
import { Result as R, type Result } from "../../shared/result.ts";

export type WorktreeUpdateStatus =
	| { status: "rebased" }
	| { status: "rebased-dirty" }
	| { status: "rebase-conflict"; message: string }
	| { status: "is-default-branch" };

export interface WorktreeReport {
	branch: string;
	path: string;
	result: WorktreeUpdateStatus;
}

export interface UpdateWorktreesOutput {
	defaultBranch: string;
	defaultBranchUpdate: "ff-updated" | "ref-updated";
	reports: WorktreeReport[];
}

export interface UpdateWorktreesDeps {
	git: GitPort;
}

export async function updateWorktrees(
	deps: UpdateWorktreesDeps,
): Promise<Result<UpdateWorktreesOutput, Error>> {
	const { git } = deps;

	const listResult = await git.listWorktrees();
	if (!listResult.success) {
		return R.err(new Error(listResult.error.message));
	}
	const worktrees = listResult.data;

	const defaultBranchResult = await git.getDefaultBranch();
	if (!defaultBranchResult.success) {
		return R.err(new Error(defaultBranchResult.error.message));
	}
	const defaultBranch = defaultBranchResult.data;

	const fetchResult = await git.fetchAll();
	if (!fetchResult.success) {
		return R.err(new Error(`Fetch failed: ${fetchResult.error.message}`));
	}

	const mainWorktree = worktrees.find((w) => w.branch === defaultBranch);
	let defaultBranchUpdate: "ff-updated" | "ref-updated";

	if (mainWorktree) {
		const ffResult = await git.mergeFFOnly(mainWorktree.path, defaultBranch);
		if (!ffResult.success) {
			return R.err(new Error(`Failed to fast-forward ${defaultBranch}: ${ffResult.error.message}`));
		}
		defaultBranchUpdate = "ff-updated";
	} else {
		const refResult = await git.updateBranchRef(defaultBranch);
		if (!refResult.success) {
			return R.err(new Error(`Failed to update ${defaultBranch} ref: ${refResult.error.message}`));
		}
		defaultBranchUpdate = "ref-updated";
	}

	const reports: WorktreeReport[] = [];

	for (const wt of worktrees) {
		if (!wt.branch) continue;

		if (wt.branch === defaultBranch) {
			reports.push({ branch: wt.branch, path: wt.path, result: { status: "is-default-branch" } });
			continue;
		}

		const dirtyResult = await git.isDirty(wt.path);
		if (!dirtyResult.success) {
			reports.push({
				branch: wt.branch,
				path: wt.path,
				result: { status: "rebase-conflict", message: "Could not check worktree status" },
			});
			continue;
		}

		const isDirty = dirtyResult.data;

		if (isDirty) {
			const stageResult = await git.stageAll(wt.path);
			if (!stageResult.success) {
				reports.push({
					branch: wt.branch,
					path: wt.path,
					result: { status: "rebase-conflict", message: "Failed to stage changes for WIP commit" },
				});
				continue;
			}
			const wipResult = await git.commitWip(wt.path);
			if (!wipResult.success) {
				reports.push({
					branch: wt.branch,
					path: wt.path,
					result: { status: "rebase-conflict", message: "Failed to create WIP commit" },
				});
				continue;
			}
		}

		const rebaseResult = await git.rebase(wt.path, defaultBranch);
		if (rebaseResult.success) {
			if (isDirty) {
				await git.resetLastCommit(wt.path);
			}
			reports.push({
				branch: wt.branch,
				path: wt.path,
				result: { status: isDirty ? "rebased-dirty" : "rebased" },
			});
		} else {
			await git.rebaseAbort(wt.path);
			if (isDirty) {
				await git.resetLastCommit(wt.path);
			}
			reports.push({
				branch: wt.branch,
				path: wt.path,
				result: { status: "rebase-conflict", message: rebaseResult.error.message },
			});
		}
	}

	return R.ok({ defaultBranch, defaultBranchUpdate, reports });
}
