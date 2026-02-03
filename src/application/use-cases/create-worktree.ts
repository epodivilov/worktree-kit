import type { Worktree } from "../../domain/entities/worktree.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";

export interface CreateWorktreeInput {
	branch: string;
	baseBranch?: string;
}

export interface CreateWorktreeOutput {
	worktree: Worktree;
}

export interface CreateWorktreeDeps {
	git: GitPort;
	fs: FilesystemPort;
}

export async function createWorktree(
	_input: CreateWorktreeInput,
	_deps: CreateWorktreeDeps,
): Promise<Result<CreateWorktreeOutput, Error>> {
	return R.err(new Error("Not implemented"));
}
