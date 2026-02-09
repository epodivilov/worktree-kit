import type { Worktree } from "../domain/entities/worktree.ts";
import type { GitError, GitPort } from "../domain/ports/git-port.ts";
import { Result } from "../shared/result.ts";

export interface FakeGitOptions {
	isRepo?: boolean;
	root?: string;
	mainRoot?: string;
	worktrees?: Worktree[];
	branches?: string[];
	remoteBranches?: string[];
	mergedBranches?: string[];
	defaultBranch?: string;
	dirtyWorktrees?: Set<string>;
	rebaseConflicts?: Set<string>;
	fetchFails?: boolean;
	mergeFFOnlyFails?: boolean;
}

export function createFakeGit(options: FakeGitOptions = {}): GitPort {
	const {
		isRepo = true,
		root = "/fake/project",
		mainRoot,
		worktrees = [],
		branches = [],
		remoteBranches = [],
		mergedBranches = [],
		defaultBranch = "main",
		dirtyWorktrees,
		rebaseConflicts,
		fetchFails = false,
		mergeFFOnlyFails = false,
	} = options;
	const store = [...worktrees];
	const branchStore = [...branches];
	const mergedBranchStore = new Set(mergedBranches);
	const deletedBranches = new Set<string>();

	return {
		async isGitRepository(): Promise<Result<boolean, GitError>> {
			return Result.ok(isRepo);
		},

		async getRepositoryRoot(): Promise<Result<string, GitError>> {
			if (!isRepo) {
				return Result.err({ code: "NOT_A_REPO", message: "Not inside a git repository" });
			}
			return Result.ok(root);
		},

		async getMainWorktreeRoot(): Promise<Result<string, GitError>> {
			if (!isRepo) {
				return Result.err({ code: "NOT_A_REPO", message: "Not inside a git repository" });
			}
			return Result.ok(mainRoot ?? root);
		},

		async listWorktrees(): Promise<Result<Worktree[], GitError>> {
			if (!isRepo) {
				return Result.err({ code: "NOT_A_REPO", message: "Not inside a git repository" });
			}
			return Result.ok([...store]);
		},

		async listBranches(): Promise<Result<string[], GitError>> {
			if (!isRepo) {
				return Result.err({ code: "NOT_A_REPO", message: "Not inside a git repository" });
			}
			return Result.ok([...branchStore]);
		},

		async listRemoteBranches(): Promise<Result<string[], GitError>> {
			if (!isRepo) {
				return Result.err({ code: "NOT_A_REPO", message: "Not inside a git repository" });
			}
			return Result.ok([...remoteBranches]);
		},

		async getDefaultBranch(): Promise<Result<string, GitError>> {
			if (!isRepo) {
				return Result.err({ code: "NOT_A_REPO", message: "Not inside a git repository" });
			}
			return Result.ok(defaultBranch);
		},

		async branchExists(branch: string): Promise<Result<boolean, GitError>> {
			return Result.ok(store.some((w) => w.branch === branch));
		},

		async createWorktree(branch: string, path: string, _baseBranch?: string): Promise<Result<Worktree, GitError>> {
			if (store.some((w) => w.branch === branch)) {
				return Result.err({ code: "BRANCH_EXISTS", message: `Branch ${branch} already exists` });
			}
			const wt: Worktree = { path, branch, head: "abc1234", isMain: false };
			store.push(wt);
			return Result.ok(wt);
		},

		async createWorktreeFromRemote(branch: string, path: string, _remote: string): Promise<Result<Worktree, GitError>> {
			if (store.some((w) => w.branch === branch)) {
				return Result.err({ code: "BRANCH_EXISTS", message: `Branch ${branch} already exists` });
			}
			const wt: Worktree = { path, branch, head: "abc1234", isMain: false };
			store.push(wt);
			return Result.ok(wt);
		},

		async removeWorktree(path: string): Promise<Result<void, GitError>> {
			const idx = store.findIndex((w) => w.path === path);
			if (idx === -1) {
				return Result.err({ code: "UNKNOWN", message: `Worktree not found at ${path}` });
			}
			store.splice(idx, 1);
			return Result.ok(undefined);
		},

		async deleteBranch(branch: string): Promise<Result<void, GitError>> {
			const branchExists = branchStore.includes(branch) || store.some((w) => w.branch === branch);
			if (!branchExists || deletedBranches.has(branch)) {
				return Result.err({ code: "BRANCH_NOT_FOUND", message: `Branch "${branch}" not found` });
			}
			if (!mergedBranchStore.has(branch)) {
				return Result.err({ code: "BRANCH_NOT_MERGED", message: `Branch "${branch}" is not fully merged` });
			}
			deletedBranches.add(branch);
			return Result.ok(undefined);
		},

		async fetchAll(): Promise<Result<void, GitError>> {
			if (fetchFails) {
				return Result.err({ code: "UNKNOWN", message: "Fetch failed" });
			}
			return Result.ok(undefined);
		},

		async mergeFFOnly(_worktreePath: string, _branch: string): Promise<Result<void, GitError>> {
			if (mergeFFOnlyFails) {
				return Result.err({ code: "MERGE_FAILED", message: "Cannot fast-forward" });
			}
			return Result.ok(undefined);
		},

		async updateBranchRef(_branch: string): Promise<Result<void, GitError>> {
			if (mergeFFOnlyFails) {
				return Result.err({ code: "MERGE_FAILED", message: "Cannot update ref" });
			}
			return Result.ok(undefined);
		},

		async rebase(worktreePath: string, _onto: string): Promise<Result<void, GitError>> {
			if (rebaseConflicts?.has(worktreePath)) {
				return Result.err({ code: "REBASE_CONFLICT", message: "Rebase conflict" });
			}
			return Result.ok(undefined);
		},

		async rebaseAbort(_worktreePath: string): Promise<Result<void, GitError>> {
			return Result.ok(undefined);
		},

		async isDirty(worktreePath: string): Promise<Result<boolean, GitError>> {
			return Result.ok(dirtyWorktrees?.has(worktreePath) ?? false);
		},

		async deleteRemoteBranch(_branch: string, _remote?: string): Promise<Result<void, GitError>> {
			return Result.ok(undefined);
		},

		async deleteBranchForce(branch: string): Promise<Result<void, GitError>> {
			const branchExists = branchStore.includes(branch) || store.some((w) => w.branch === branch);
			if (!branchExists || deletedBranches.has(branch)) {
				return Result.err({ code: "BRANCH_NOT_FOUND", message: `Branch "${branch}" not found` });
			}
			deletedBranches.add(branch);
			return Result.ok(undefined);
		},
	};
}
