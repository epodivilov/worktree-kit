import type { Result } from "../../shared/result.ts";
import type { Worktree } from "../entities/worktree.ts";

export interface GitError {
	readonly code:
		| "NOT_A_REPO"
		| "WORKTREE_EXISTS"
		| "BRANCH_EXISTS"
		| "BRANCH_NOT_MERGED"
		| "BRANCH_NOT_FOUND"
		| "UNKNOWN";
	readonly message: string;
}

export interface GitPort {
	isGitRepository(): Promise<Result<boolean, GitError>>;
	getRepositoryRoot(): Promise<Result<string, GitError>>;
	getMainWorktreeRoot(): Promise<Result<string, GitError>>;
	listWorktrees(): Promise<Result<Worktree[], GitError>>;
	listBranches(): Promise<Result<string[], GitError>>;
	listRemoteBranches(): Promise<Result<string[], GitError>>;
	branchExists(branch: string): Promise<Result<boolean, GitError>>;
	createWorktree(branch: string, path: string): Promise<Result<Worktree, GitError>>;
	createWorktreeFromRemote(branch: string, path: string, remote: string): Promise<Result<Worktree, GitError>>;
	removeWorktree(path: string): Promise<Result<void, GitError>>;
	deleteBranch(branch: string): Promise<Result<void, GitError>>;
	deleteBranchForce(branch: string): Promise<Result<void, GitError>>;
}
