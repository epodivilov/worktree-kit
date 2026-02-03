import type { Worktree } from "../../domain/entities/worktree.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";

export interface ListWorktreesOutput {
	worktrees: Worktree[];
}

export interface ListWorktreesDeps {
	git: GitPort;
}

export async function listWorktrees(_deps: ListWorktreesDeps): Promise<Result<ListWorktreesOutput, Error>> {
	return R.err(new Error("Not implemented"));
}
