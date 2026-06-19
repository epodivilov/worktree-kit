import type { GitPort } from "../../domain/ports/git-port.ts";
import { Result } from "../../shared/result.ts";

/**
 * Result of attempting to delete the remote-tracking branch, when requested.
 *
 * - `deleted`     — remote ref was removed successfully
 * - `not-found`   — remote returned REMOTE_REF_NOT_FOUND (treated as success: nothing to delete)
 * - `failed`      — any other remote failure (rendered as a warning in the CLI)
 * - `skipped`     — caller did not request remote deletion
 */
export type RemoteDeletionOutcome =
	| { status: "deleted" }
	| { status: "not-found" }
	| { status: "failed"; message: string }
	| { status: "skipped" };

/**
 * Typed outcome of the delete-branch policy.
 *
 * - `deleted`     — local branch was removed (either by the normal delete or by
 *                   the force fallback). `remote` carries the remote-deletion
 *                   sub-outcome.
 * - `not-merged`  — `deleteBranch` reported BRANCH_NOT_MERGED and the caller did
 *                   not request force; no remote deletion was attempted.
 * - `failed`      — local deletion failed for any other reason, including a force
 *                   fallback that itself failed. `message` is the git error message.
 */
export type DeleteBranchOutcome =
	| { status: "deleted"; remote: RemoteDeletionOutcome }
	| { status: "not-merged" }
	| { status: "failed"; message: string };

export interface DeleteBranchInput {
	branch: string;
	/** When true, fall back to deleteBranchForce on BRANCH_NOT_MERGED. */
	force: boolean;
	/** When true, attempt to delete the remote-tracking branch after the local delete. */
	deleteRemote: boolean;
}

export interface DeleteBranchDeps {
	git: GitPort;
}

export async function deleteBranch(input: DeleteBranchInput, deps: DeleteBranchDeps): Promise<DeleteBranchOutcome> {
	const { git } = deps;
	const { branch, force, deleteRemote } = input;

	const deleteResult = await git.deleteBranch(branch);

	if (Result.isErr(deleteResult)) {
		if (deleteResult.error.code !== "BRANCH_NOT_MERGED") {
			return { status: "failed", message: deleteResult.error.message };
		}
		if (!force) {
			return { status: "not-merged" };
		}
		const forceResult = await git.deleteBranchForce(branch);
		if (Result.isErr(forceResult)) {
			return { status: "failed", message: forceResult.error.message };
		}
	}

	const remote = deleteRemote ? await deleteRemoteBranch(branch, git) : ({ status: "skipped" } as const);
	return { status: "deleted", remote };
}

async function deleteRemoteBranch(branch: string, git: GitPort): Promise<RemoteDeletionOutcome> {
	const remoteResult = await git.deleteRemoteBranch(branch);
	if (Result.isOk(remoteResult)) {
		return { status: "deleted" };
	}
	if (remoteResult.error.code === "REMOTE_REF_NOT_FOUND") {
		return { status: "not-found" };
	}
	return { status: "failed", message: remoteResult.error.message };
}
