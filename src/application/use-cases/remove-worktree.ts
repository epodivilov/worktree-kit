import type { Worktree } from "../../domain/entities/worktree.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";

export interface RemoveWorktreeInput {
	worktree: Worktree;
	force?: boolean;
}

/**
 * Typed outcome of attempting to remove a worktree.
 *
 * - `removed` — the worktree was deleted.
 * - `pruned`  — an orphaned (prunable) worktree was pruned.
 * - `locked`  — git refused because the worktree is locked (e.g. another task
 *               holds it). This is an expected, benign state — NOT a failure —
 *               so it is surfaced on the success channel with the `path` and the
 *               (possibly empty) lock `reason`, letting the CLI group it instead
 *               of rendering a red error.
 */
export type RemoveWorktreeOutput =
	| { status: "removed"; removedPath: string }
	| { status: "pruned"; removedPath: string }
	| { status: "locked"; path: string; reason: string };

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
		return R.ok({ status: "pruned", removedPath: worktree.path });
	}

	const removeResult = await git.removeWorktree(worktree.path, { force: input.force });
	if (!removeResult.success) {
		if (removeResult.error.code === "WORKTREE_LOCKED") {
			return R.ok({ status: "locked", path: worktree.path, reason: removeResult.error.message.trim() });
		}
		return R.err(new Error(`Failed to remove worktree: ${removeResult.error.message}`));
	}

	return R.ok({ status: "removed", removedPath: worktree.path });
}
