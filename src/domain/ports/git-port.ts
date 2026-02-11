import type { Result } from "../../shared/result.ts";
import type { Worktree } from "../entities/worktree.ts";

export interface GitError {
	readonly code:
		| "NOT_A_REPO"
		| "WORKTREE_EXISTS"
		| "BRANCH_EXISTS"
		| "BRANCH_NOT_MERGED"
		| "BRANCH_NOT_FOUND"
		| "REMOTE_REF_NOT_FOUND"
		| "MERGE_FAILED"
		| "REBASE_CONFLICT"
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
	getDefaultBranch(): Promise<Result<string, GitError>>;
	createWorktree(branch: string, path: string, baseBranch?: string): Promise<Result<Worktree, GitError>>;
	createWorktreeFromRemote(branch: string, path: string, remote: string): Promise<Result<Worktree, GitError>>;
	removeWorktree(path: string): Promise<Result<void, GitError>>;
	deleteBranch(branch: string): Promise<Result<void, GitError>>;
	deleteBranchForce(branch: string): Promise<Result<void, GitError>>;
	deleteRemoteBranch(branch: string, remote?: string): Promise<Result<void, GitError>>;
	fetchAll(): Promise<Result<void, GitError>>;
	fetchPrune(): Promise<Result<void, GitError>>;
	listGoneBranches(): Promise<Result<string[], GitError>>;
	mergeFFOnly(worktreePath: string, branch: string): Promise<Result<void, GitError>>;
	updateBranchRef(branch: string): Promise<Result<void, GitError>>;
	rebase(worktreePath: string, onto: string): Promise<Result<void, GitError>>;
	rebaseAbort(worktreePath: string): Promise<Result<void, GitError>>;
	isDirty(worktreePath: string): Promise<Result<boolean, GitError>>;
	stageAll(worktreePath: string): Promise<Result<void, GitError>>;
	commitWip(worktreePath: string): Promise<Result<void, GitError>>;
	resetLastCommit(worktreePath: string): Promise<Result<void, GitError>>;
	getMergeBase(branchA: string, branchB: string): Promise<Result<string, GitError>>;
	getCommitCount(from: string, to: string): Promise<Result<number, GitError>>;
}
