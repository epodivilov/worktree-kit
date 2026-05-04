import type { Worktree } from "../../domain/entities/worktree.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";

export interface RemoveWorktreeInput {
	worktree: Worktree;
	force?: boolean;
}

export interface RemoveWorktreeOutput {
	removedPath: string;
	pruned: boolean;
}

export interface RemoveWorktreeDeps {
	git: GitPort;
}

export async function removeWorktree(
	input: RemoveWorktreeInput,
	deps: RemoveWorktreeDeps,
): Promise<Result<RemoveWorktreeOutput, Error>> {
	const { git } = deps;
	const { worktree } = input;

	if (worktree.isMain) {
		return R.err(new Error("Cannot remove the main worktree"));
	}

	if (worktree.isPrunable) {
		const pruneResult = await git.pruneWorktree(worktree.path);
		if (!pruneResult.success) {
			return R.err(new Error(`Failed to prune worktree: ${pruneResult.error.message}`));
		}
		return R.ok({ removedPath: worktree.path, pruned: true });
	}

	const removeResult = await git.removeWorktree(worktree.path, { force: input.force });
	if (!removeResult.success) {
		return R.err(new Error(`Failed to remove worktree: ${removeResult.error.message}`));
	}

	return R.ok({ removedPath: worktree.path, pruned: false });
}
