import type { Worktree } from "../../domain/entities/worktree.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { ShellPort } from "../../domain/ports/shell-port.ts";
import type { Notification } from "../../shared/notification.ts";
import { Result as R, type Result } from "../../shared/result.ts";
import { runHooks } from "./run-hooks.ts";

export interface UpdateWorktreesInput {
	dryRun: boolean;
	branch?: string;
	postUpdateHooks?: readonly string[];
	repoRoot?: string;
}

export type WorktreeUpdateStatus =
	| { status: "rebased" }
	| { status: "rebased-dirty" }
	| { status: "rebase-conflict"; message: string }
	| { status: "is-default-branch" }
	| { status: "dry-run"; dirty: boolean }
	| { status: "skipped"; reason: string };

export interface WorktreeReport {
	branch: string;
	path: string;
	parent?: string;
	result: WorktreeUpdateStatus;
}

export interface UpdateWorktreesOutput {
	defaultBranch: string;
	defaultBranchUpdate: "ff-updated" | "ref-updated";
	reports: WorktreeReport[];
	hookNotifications: Notification[];
}

export interface UpdateWorktreesDeps {
	git: GitPort;
	shell?: ShellPort;
}

async function findParentBranch(
	branch: string,
	worktrees: Worktree[],
	defaultBranch: string,
	git: GitPort,
): Promise<string> {
	const candidates: { branch: string; distance: number }[] = [];

	const defaultMergeBase = await git.getMergeBase(branch, defaultBranch);
	if (defaultMergeBase.success) {
		const defaultCount = await git.getCommitCount(defaultMergeBase.data, branch);
		if (defaultCount.success && defaultCount.data === 0) {
			return defaultBranch;
		}
		if (defaultCount.success && defaultCount.data > 0) {
			candidates.push({ branch: defaultBranch, distance: defaultCount.data });
		}
	}

	for (const wt of worktrees) {
		if (!wt.branch || wt.branch === branch || wt.branch === defaultBranch) continue;

		const mergeBaseResult = await git.getMergeBase(branch, wt.branch);
		if (!mergeBaseResult.success) continue;

		const countResult = await git.getCommitCount(mergeBaseResult.data, branch);
		if (!countResult.success) continue;

		if (countResult.data === 0) continue;

		candidates.push({ branch: wt.branch, distance: countResult.data });
	}

	if (candidates.length === 0) return defaultBranch;

	candidates.sort((a, b) => a.distance - b.distance);
	const closest = candidates[0];
	return closest ? closest.branch : defaultBranch;
}

function buildRebaseOrder(worktrees: Worktree[], parentMap: Record<string, string>, defaultBranch: string): Worktree[] {
	const children = new Map<string, string[]>();
	for (const wt of worktrees) {
		if (!wt.branch || wt.branch === defaultBranch) continue;
		const parent = parentMap[wt.branch] ?? defaultBranch;
		const siblings = children.get(parent);
		if (siblings) {
			siblings.push(wt.branch);
		} else {
			children.set(parent, [wt.branch]);
		}
	}

	const ordered: string[] = [];
	const queue: string[] = [defaultBranch];

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) break;
		if (current !== defaultBranch) {
			ordered.push(current);
		}
		const kids = children.get(current) ?? [];
		for (const kid of kids) {
			queue.push(kid);
		}
	}

	const wtMap = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch, w]));
	return ordered.filter((b) => wtMap.has(b)).map((b) => wtMap.get(b) as Worktree);
}

function filterDescendants(
	targetBranch: string,
	orderedWorktrees: Worktree[],
	parentMap: Record<string, string>,
): Worktree[] {
	return orderedWorktrees.filter((wt) => {
		let current = wt.branch;
		while (current) {
			if (current === targetBranch) return true;
			const parent = parentMap[current];
			if (!parent || parent === current) return false;
			current = parent;
		}
		return false;
	});
}

export async function updateWorktrees(
	input: UpdateWorktreesInput,
	deps: UpdateWorktreesDeps,
): Promise<Result<UpdateWorktreesOutput, Error>> {
	const { git } = deps;

	const listResult = await git.listWorktrees();
	if (!listResult.success) {
		return R.err(new Error(listResult.error.message));
	}
	const worktrees = listResult.data;

	const defaultBranchResult = await git.getDefaultBranch();
	if (!defaultBranchResult.success) {
		return R.err(new Error(defaultBranchResult.error.message));
	}
	const defaultBranch = defaultBranchResult.data;

	const fetchResult = await git.fetchAll();
	if (!fetchResult.success) {
		return R.err(new Error(`Fetch failed: ${fetchResult.error.message}`));
	}

	const mainWorktree = worktrees.find((w) => w.branch === defaultBranch);
	let defaultBranchUpdate: "ff-updated" | "ref-updated";

	if (mainWorktree) {
		const ffResult = await git.mergeFFOnly(mainWorktree.path, defaultBranch);
		if (!ffResult.success) {
			return R.err(new Error(`Failed to fast-forward ${defaultBranch}: ${ffResult.error.message}`));
		}
		defaultBranchUpdate = "ff-updated";
	} else {
		const refResult = await git.updateBranchRef(defaultBranch);
		if (!refResult.success) {
			return R.err(new Error(`Failed to update ${defaultBranch} ref: ${refResult.error.message}`));
		}
		defaultBranchUpdate = "ref-updated";
	}

	const parentMap: Record<string, string> = {};
	for (const wt of worktrees) {
		if (!wt.branch || wt.branch === defaultBranch) continue;
		parentMap[wt.branch] = await findParentBranch(wt.branch, worktrees, defaultBranch, git);
	}

	const orderedWorktrees = buildRebaseOrder(worktrees, parentMap, defaultBranch);

	if (input.branch && input.branch !== defaultBranch && !worktrees.some((w) => w.branch === input.branch)) {
		return R.err(new Error(`Branch "${input.branch}" not found in worktrees`));
	}

	const targetWorktrees =
		input.branch && input.branch !== defaultBranch
			? filterDescendants(input.branch, orderedWorktrees, parentMap)
			: orderedWorktrees;

	const reports: WorktreeReport[] = [];
	const failedBranches = new Set<string>();

	if (mainWorktree) {
		reports.push({ branch: defaultBranch, path: mainWorktree.path, result: { status: "is-default-branch" } });
	}

	for (const wt of targetWorktrees) {
		const parent = parentMap[wt.branch] ?? defaultBranch;

		if (failedBranches.has(parent)) {
			reports.push({
				branch: wt.branch,
				path: wt.path,
				parent,
				result: { status: "skipped", reason: `parent ${parent} failed` },
			});
			failedBranches.add(wt.branch);
			continue;
		}

		const dirtyResult = await git.isDirty(wt.path);
		if (!dirtyResult.success) {
			reports.push({
				branch: wt.branch,
				path: wt.path,
				parent,
				result: { status: "rebase-conflict", message: "Could not check worktree status" },
			});
			failedBranches.add(wt.branch);
			continue;
		}

		const isDirty = dirtyResult.data;

		if (input.dryRun) {
			reports.push({
				branch: wt.branch,
				path: wt.path,
				parent,
				result: { status: "dry-run", dirty: isDirty },
			});
			continue;
		}

		if (isDirty) {
			const stageResult = await git.stageAll(wt.path);
			if (!stageResult.success) {
				reports.push({
					branch: wt.branch,
					path: wt.path,
					parent,
					result: { status: "rebase-conflict", message: "Failed to stage changes for WIP commit" },
				});
				failedBranches.add(wt.branch);
				continue;
			}
			const wipResult = await git.commitWip(wt.path);
			if (!wipResult.success) {
				reports.push({
					branch: wt.branch,
					path: wt.path,
					parent,
					result: { status: "rebase-conflict", message: "Failed to create WIP commit" },
				});
				failedBranches.add(wt.branch);
				continue;
			}
		}

		const rebaseResult = await git.rebase(wt.path, parent);
		if (rebaseResult.success) {
			if (isDirty) {
				await git.resetLastCommit(wt.path);
			}
			reports.push({
				branch: wt.branch,
				path: wt.path,
				parent,
				result: { status: isDirty ? "rebased-dirty" : "rebased" },
			});
		} else {
			await git.rebaseAbort(wt.path);
			if (isDirty) {
				await git.resetLastCommit(wt.path);
			}
			reports.push({
				branch: wt.branch,
				path: wt.path,
				parent,
				result: { status: "rebase-conflict", message: rebaseResult.error.message },
			});
			failedBranches.add(wt.branch);
		}
	}

	const hookNotifications: Notification[] = [];

	if (input.postUpdateHooks?.length && deps.shell) {
		for (const report of reports) {
			if (report.result.status === "rebased" || report.result.status === "rebased-dirty") {
				const hookResult = await runHooks(
					{
						commands: input.postUpdateHooks,
						context: {
							worktreePath: report.path,
							branch: report.branch,
							repoRoot: input.repoRoot ?? "",
							baseBranch: report.parent,
						},
					},
					{ shell: deps.shell },
				);
				if (hookResult.success) {
					hookNotifications.push(...hookResult.data.notifications);
				}
			}
		}
	}

	return R.ok({ defaultBranch, defaultBranchUpdate, reports, hookNotifications });
}
