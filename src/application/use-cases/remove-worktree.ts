import type { GitPort } from "../../domain/ports/git-port.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";

export interface RemoveWorktreeInput {
	branch: string;
}

export interface RemoveWorktreeOutput {
	removedPath: string;
}

export interface RemoveWorktreeDeps {
	git: GitPort;
}

export async function removeWorktree(
	input: RemoveWorktreeInput,
	deps: RemoveWorktreeDeps,
): Promise<Result<RemoveWorktreeOutput, Error>> {
	const { git } = deps;

	const listResult = await git.listWorktrees();
	if (!listResult.success) {
		return R.err(new Error(`Failed to list worktrees: ${listResult.error.message}`));
	}

	const worktree = listResult.data.find((w) => w.branch === input.branch);
	if (!worktree) {
		return R.err(new Error(`Worktree for branch "${input.branch}" not found`));
	}

	if (worktree.isMain) {
		return R.err(new Error("Cannot remove the main worktree"));
	}

	const removeResult = await git.removeWorktree(worktree.path);
	if (!removeResult.success) {
		return R.err(new Error(`Failed to remove worktree: ${removeResult.error.message}`));
	}

	return R.ok({ removedPath: worktree.path });
}
