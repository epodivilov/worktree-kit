import type { Worktree } from "../domain/entities/worktree.ts";
import type { GitError, GitPort } from "../domain/ports/git-port.ts";
import { Result } from "../shared/result.ts";

export interface FakeRebaseCall {
	worktreePath: string;
	onto: string;
	opts?: { upstream: string; branch: string };
}

export interface FakeGitOptions {
	isRepo?: boolean;
	root?: string;
	mainRoot?: string;
	worktrees?: Worktree[];
	branches?: string[];
	remoteBranches?: string[];
	mergedBranches?: string[];
	goneBranches?: string[];
	defaultBranch?: string;
	dirtyWorktrees?: Set<string>;
	rebaseConflicts?: Set<string>;
	mergeInProgress?: Set<string>;
	onConflictResolved?: Set<string>;
	fetchFails?: boolean;
	mergeFFOnlyFails?: boolean;
	mergeBaseMap?: Map<string, string>;
	commitCountMap?: Map<string, number>;
	trackedPaths?: Set<string>;
	pruneFailPaths?: Map<string, string>;
	pruneCalls?: string[];
	rebaseCalls?: FakeRebaseCall[];
	revListMap?: Map<string, string[]>;
	revListCherryPickMap?: Map<string, string[]>;
	logSubjectsMap?: Map<string, { sha: string; subject: string }[]>;
	diffTreeFilesMap?: Map<string, string[]>;
	diffNormalizedMap?: Map<string, string>;
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
		goneBranches = [],
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
			return Result.ok(branchStore.filter((b) => !deletedBranches.has(b)));
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
			return Result.ok(branchStore.includes(branch) && !deletedBranches.has(branch));
		},

		async createWorktree(branch: string, path: string, _baseBranch?: string): Promise<Result<Worktree, GitError>> {
			if (store.some((w) => w.branch === branch)) {
				return Result.err({ code: "BRANCH_EXISTS", message: `Branch ${branch} already exists` });
			}
			const wt: Worktree = { path, branch, head: "abc1234", isMain: false, isPrunable: false };
			store.push(wt);
			return Result.ok(wt);
		},

		async createWorktreeFromRemote(branch: string, path: string, _remote: string): Promise<Result<Worktree, GitError>> {
			if (store.some((w) => w.branch === branch)) {
				return Result.err({ code: "BRANCH_EXISTS", message: `Branch ${branch} already exists` });
			}
			const wt: Worktree = { path, branch, head: "abc1234", isMain: false, isPrunable: false };
			store.push(wt);
			return Result.ok(wt);
		},

		async removeWorktree(path: string, _options?: { force?: boolean }): Promise<Result<void, GitError>> {
			const idx = store.findIndex((w) => w.path === path);
			if (idx === -1) {
				return Result.err({ code: "UNKNOWN", message: `Worktree not found at ${path}` });
			}
			store.splice(idx, 1);
			return Result.ok(undefined);
		},

		async pruneWorktree(path: string): Promise<Result<void, GitError>> {
			options.pruneCalls?.push(path);
			const failMessage = options.pruneFailPaths?.get(path);
			if (failMessage !== undefined) {
				return Result.err({ code: "UNKNOWN", message: failMessage });
			}
			const idx = store.findIndex((w) => w.path === path);
			if (idx !== -1) {
				const target = store[idx] as Worktree;
				if (!target.isPrunable) {
					return Result.err({
						code: "UNKNOWN",
						message: `Worktree at "${path}" is not prunable`,
					});
				}
				store.splice(idx, 1);
			}
			return Result.ok(undefined);
		},

		async deleteBranch(branch: string): Promise<Result<void, GitError>> {
			if (!branchStore.includes(branch) || deletedBranches.has(branch)) {
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

		async fetchPrune(): Promise<Result<void, GitError>> {
			if (fetchFails) {
				return Result.err({ code: "UNKNOWN", message: "Fetch failed" });
			}
			return Result.ok(undefined);
		},

		async listGoneBranches(): Promise<Result<string[], GitError>> {
			if (!isRepo) {
				return Result.err({ code: "NOT_A_REPO", message: "Not inside a git repository" });
			}
			return Result.ok([...goneBranches]);
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

		async rebase(
			worktreePath: string,
			onto: string,
			opts?: { upstream: string; branch: string },
		): Promise<Result<void, GitError>> {
			options.rebaseCalls?.push({ worktreePath, onto, opts });
			if (rebaseConflicts?.has(worktreePath)) {
				return Result.err({ code: "REBASE_CONFLICT", message: "Rebase conflict" });
			}
			return Result.ok(undefined);
		},

		async revList({ range }: { range: string }): Promise<Result<string[], GitError>> {
			return Result.ok(options.revListMap?.get(range) ?? []);
		},

		async revListCherryPick({ base, feature }: { base: string; feature: string }): Promise<Result<string[], GitError>> {
			return Result.ok(options.revListCherryPickMap?.get(`${base}...${feature}`) ?? []);
		},

		async logSubjects(range: string, limit?: number): Promise<Result<{ sha: string; subject: string }[], GitError>> {
			const entries = options.logSubjectsMap?.get(range) ?? [];
			return Result.ok(limit !== undefined ? entries.slice(0, limit) : entries);
		},

		async diffTreeFiles(sha: string): Promise<Result<string[], GitError>> {
			return Result.ok(options.diffTreeFilesMap?.get(sha) ?? []);
		},

		async diffNormalized({ from, to }: { from: string; to: string }): Promise<Result<string, GitError>> {
			return Result.ok(options.diffNormalizedMap?.get(`${from}..${to}`) ?? "");
		},

		async rebaseAbort(_worktreePath: string): Promise<Result<void, GitError>> {
			return Result.ok(undefined);
		},

		async isRebaseInProgress(worktreePath: string): Promise<boolean> {
			if (rebaseConflicts?.has(worktreePath) && options.onConflictResolved?.has(worktreePath)) {
				return false;
			}
			return rebaseConflicts?.has(worktreePath) ?? false;
		},

		async isMergeInProgress(worktreePath: string): Promise<boolean> {
			return options.mergeInProgress?.has(worktreePath) ?? false;
		},

		async isDirty(worktreePath: string): Promise<Result<boolean, GitError>> {
			return Result.ok(dirtyWorktrees?.has(worktreePath) ?? false);
		},

		async stageAll(_worktreePath: string): Promise<Result<void, GitError>> {
			return Result.ok(undefined);
		},

		async commitWip(_worktreePath: string): Promise<Result<void, GitError>> {
			return Result.ok(undefined);
		},

		async resetLastCommit(_worktreePath: string): Promise<Result<void, GitError>> {
			return Result.ok(undefined);
		},

		async deleteRemoteBranch(_branch: string, _remote?: string): Promise<Result<void, GitError>> {
			return Result.ok(undefined);
		},

		async getMergeBase(branchA: string, branchB: string): Promise<Result<string, GitError>> {
			const key = `${branchA}:${branchB}`;
			const sha = options.mergeBaseMap?.get(key);
			if (!sha) {
				return Result.err({
					code: "UNKNOWN",
					message: `No merge-base configured for ${branchA} and ${branchB}`,
				});
			}
			return Result.ok(sha);
		},

		async getCommitCount(from: string, to: string): Promise<Result<number, GitError>> {
			const key = `${from}..${to}`;
			const count = options.commitCountMap?.get(key);
			if (count === undefined) {
				return Result.err({
					code: "UNKNOWN",
					message: `No commit count configured for ${from}..${to}`,
				});
			}
			return Result.ok(count);
		},

		async getLastCommitMessage(_worktreePath: string): Promise<Result<string, GitError>> {
			return Result.ok("fake message");
		},

		async isPathTracked(_repoRoot: string, relativePath: string): Promise<Result<boolean, GitError>> {
			return Result.ok(options.trackedPaths?.has(relativePath) ?? false);
		},

		async deleteBranchForce(branch: string): Promise<Result<void, GitError>> {
			if (!branchStore.includes(branch) || deletedBranches.has(branch)) {
				return Result.err({ code: "BRANCH_NOT_FOUND", message: `Branch "${branch}" not found` });
			}
			deletedBranches.add(branch);
			return Result.ok(undefined);
		},
	};
}
