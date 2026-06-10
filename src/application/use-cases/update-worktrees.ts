import type { Worktree } from "../../domain/entities/worktree.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { ShellPort } from "../../domain/ports/shell-port.ts";
import type { Notification } from "../../shared/notification.ts";
import { Result as R, type Result } from "../../shared/result.ts";
import { findCherryPickedPrefix } from "./find-cherry-picked-prefix.ts";
import { findSquashMergedPrefix } from "./find-squash-merged-prefix.ts";
import { runHooks } from "./run-hooks.ts";

const WIP_RESTORE_FAILED =
	"failed to restore WIP commit — your changes are kept in a WIP commit (run 'git reset --soft HEAD~1' to unpack)";

export interface UpdateWorktreesInput {
	dryRun: boolean;
	branch?: string;
	postUpdateHooks?: readonly string[];
	onConflictHooks?: readonly string[];
	repoRoot?: string;
	/** Name of the upstream remote to sync the default branch from (fork workflow). */
	upstream?: string;
}

export type WorktreeUpdateStatus =
	| { status: "rebased"; warning?: string }
	| { status: "rebased-dirty"; warning?: string }
	| { status: "rebase-conflict"; message: string; warning?: string }
	| { status: "is-default-branch" }
	| { status: "dry-run"; dirty: boolean }
	| { status: "skipped"; reason: string };

export interface WorktreeReport {
	branch: string;
	path: string;
	parent?: string;
	/** Set when the branch's natural parent had a gone remote and was skipped in favor of `parent`. */
	retargetedFrom?: string;
	result: WorktreeUpdateStatus;
	hookNotifications: Notification[];
}

export interface UpdateWorktreesOutput {
	defaultBranch: string;
	defaultBranchUpdate: "ff-updated" | "ref-updated";
	/** Set to the upstream remote name when the default branch was synced from upstream. */
	syncedFromUpstream?: string;
	reports: WorktreeReport[];
}

export interface UpdateWorktreesDeps {
	git: GitPort;
	shell?: ShellPort;
}

async function findParentBranch(
	branch: string,
	worktrees: Worktree[],
	defaultBranch: string,
	goneSet: Set<string>,
	git: GitPort,
): Promise<{ parent: string; retargetedFrom?: string }> {
	const candidates: { branch: string; distance: number; gone: boolean }[] = [];

	const defaultMergeBase = await git.getMergeBase(branch, defaultBranch);
	if (defaultMergeBase.success) {
		const defaultCount = await git.getCommitCount(defaultMergeBase.data, branch);
		if (defaultCount.success && defaultCount.data === 0) {
			return { parent: defaultBranch };
		}
		if (defaultCount.success && defaultCount.data > 0) {
			candidates.push({ branch: defaultBranch, distance: defaultCount.data, gone: false });
		}
	}

	for (const wt of worktrees) {
		if (!wt.branch || wt.branch === branch || wt.branch === defaultBranch) continue;

		const mergeBaseResult = await git.getMergeBase(branch, wt.branch);
		if (!mergeBaseResult.success) continue;

		const countResult = await git.getCommitCount(mergeBaseResult.data, branch);
		if (!countResult.success) continue;

		if (countResult.data === 0) continue;

		candidates.push({ branch: wt.branch, distance: countResult.data, gone: goneSet.has(wt.branch) });
	}

	if (candidates.length === 0) return { parent: defaultBranch };

	candidates.sort((a, b) => a.distance - b.distance);

	// Pick the closest branch whose remote still exists; gone branches are about to be
	// cleaned up, so rebasing onto them would leave this branch stranded on a dead base.
	const liveParent = candidates.find((c) => !c.gone)?.branch ?? defaultBranch;
	const closest = candidates[0];
	if (closest?.gone) {
		return { parent: liveParent, retargetedFrom: closest.branch };
	}

	return { parent: liveParent };
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

	const fetchResult = await git.fetchPrune();
	if (!fetchResult.success) {
		return R.err(new Error(`Fetch failed: ${fetchResult.error.message}`));
	}

	const goneResult = await git.listGoneBranches();
	const goneSet = new Set(goneResult.success ? goneResult.data.filter((b) => b !== defaultBranch) : []);

	const mainWorktree = worktrees.find((w) => w.branch === defaultBranch);
	let defaultBranchUpdate: "ff-updated" | "ref-updated";
	let defaultBranchHookNotifications: Notification[] = [];
	let syncedFromUpstream: string | undefined;

	if (mainWorktree) {
		const ffResult = input.upstream
			? await git.mergeFFOnly(mainWorktree.path, defaultBranch, input.upstream)
			: await git.mergeFFOnly(mainWorktree.path, defaultBranch);
		if (!ffResult.success) {
			return R.err(new Error(`Failed to fast-forward ${defaultBranch}: ${ffResult.error.message}`));
		}
		defaultBranchUpdate = "ff-updated";

		// When syncing the default branch from an upstream remote, run post-update hooks
		// for the default branch too (mirrors the feature-branch path).
		if (input.upstream) {
			syncedFromUpstream = input.upstream;
			if (!input.dryRun && input.postUpdateHooks?.length && deps.shell) {
				const baseRef = `${input.upstream}/${defaultBranch}`;
				const hookResult = await runHooks(
					{
						commands: input.postUpdateHooks,
						context: {
							worktreePath: mainWorktree.path,
							branch: defaultBranch,
							repoRoot: input.repoRoot ?? "",
							baseBranch: baseRef,
						},
					},
					{ shell: deps.shell },
				);
				if (hookResult.success) {
					defaultBranchHookNotifications = hookResult.data.notifications;
				}
			}
		}
	} else {
		const refResult = await git.updateBranchRef(defaultBranch);
		if (!refResult.success) {
			return R.err(new Error(`Failed to update ${defaultBranch} ref: ${refResult.error.message}`));
		}
		defaultBranchUpdate = "ref-updated";
	}

	const parentMap: Record<string, string> = {};
	const retargetMap: Record<string, string> = {};
	for (const wt of worktrees) {
		if (!wt.branch || wt.branch === defaultBranch) continue;
		const resolved = await findParentBranch(wt.branch, worktrees, defaultBranch, goneSet, git);
		parentMap[wt.branch] = resolved.parent;
		if (resolved.retargetedFrom) {
			retargetMap[wt.branch] = resolved.retargetedFrom;
		}
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
		reports.push({
			branch: defaultBranch,
			path: mainWorktree.path,
			result: { status: "is-default-branch" },
			hookNotifications: defaultBranchHookNotifications,
		});
	}

	for (const wt of targetWorktrees) {
		const parent = parentMap[wt.branch] ?? defaultBranch;

		if (failedBranches.has(parent)) {
			reports.push({
				branch: wt.branch,
				path: wt.path,
				parent,
				retargetedFrom: retargetMap[wt.branch],
				result: { status: "skipped", reason: `parent ${parent} failed` },
				hookNotifications: [],
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
				retargetedFrom: retargetMap[wt.branch],
				result: { status: "rebase-conflict", message: "Could not check worktree status" },
				hookNotifications: [],
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
				retargetedFrom: retargetMap[wt.branch],
				result: { status: "dry-run", dirty: isDirty },
				hookNotifications: [],
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
					retargetedFrom: retargetMap[wt.branch],
					result: { status: "rebase-conflict", message: "Failed to stage changes for WIP commit" },
					hookNotifications: [],
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
					retargetedFrom: retargetMap[wt.branch],
					result: { status: "rebase-conflict", message: "Failed to create WIP commit" },
					hookNotifications: [],
				});
				failedBranches.add(wt.branch);
				continue;
			}
		}

		const cherryPickPrefix = await findCherryPickedPrefix({ git }, { base: parent, feature: wt.branch });
		const squashPrefix = cherryPickPrefix
			? null
			: await findSquashMergedPrefix({ git }, { base: parent, feature: wt.branch });
		const prefix = cherryPickPrefix ?? squashPrefix;

		if (prefix && prefix.skippedCount === prefix.totalCount) {
			if (isDirty) {
				const resetResult = await git.resetLastCommit(wt.path);
				if (!resetResult.success) {
					reports.push({
						branch: wt.branch,
						path: wt.path,
						parent,
						retargetedFrom: retargetMap[wt.branch],
						result: { status: "rebase-conflict", message: "Failed to restore WIP commit after fully-merged detection" },
						hookNotifications: [],
					});
					failedBranches.add(wt.branch);
					continue;
				}
			}
			reports.push({
				branch: wt.branch,
				path: wt.path,
				parent,
				retargetedFrom: retargetMap[wt.branch],
				result: { status: "skipped", reason: "fully merged" },
				hookNotifications: [],
			});
			continue;
		}

		const rebaseResult = prefix
			? await git.rebase(wt.path, parent, { upstream: prefix.lastSkippedCommit, branch: wt.branch })
			: await git.rebase(wt.path, parent);
		if (rebaseResult.success) {
			let warning: string | undefined;
			if (isDirty) {
				const resetResult = await git.resetLastCommit(wt.path);
				if (!resetResult.success) {
					warning = WIP_RESTORE_FAILED;
				}
			}

			let hookNotifications: Notification[] = [];
			if (input.postUpdateHooks?.length && deps.shell) {
				const hookResult = await runHooks(
					{
						commands: input.postUpdateHooks,
						context: {
							worktreePath: wt.path,
							branch: wt.branch,
							repoRoot: input.repoRoot ?? "",
							baseBranch: parent,
						},
					},
					{ shell: deps.shell },
				);
				if (hookResult.success) {
					hookNotifications = hookResult.data.notifications;
				}
			}

			reports.push({
				branch: wt.branch,
				path: wt.path,
				parent,
				retargetedFrom: retargetMap[wt.branch],
				result: { status: isDirty ? "rebased-dirty" : "rebased", warning },
				hookNotifications,
			});
		} else {
			let conflictResolved = false;

			if (input.onConflictHooks?.length && deps.shell) {
				await runHooks(
					{
						commands: input.onConflictHooks,
						context: {
							worktreePath: wt.path,
							branch: wt.branch,
							repoRoot: input.repoRoot ?? "",
							baseBranch: parent,
						},
					},
					{ shell: deps.shell },
				);

				// On check failure assume the conflict is unresolved: falsely reporting
				// "resolved" would resetLastCommit in the middle of a rebase
				const stillRebasing = await git.isRebaseInProgress(wt.path);
				conflictResolved = stillRebasing.success && !stillRebasing.data;
			}

			if (conflictResolved) {
				let warning: string | undefined;
				if (isDirty) {
					const resetResult = await git.resetLastCommit(wt.path);
					if (!resetResult.success) {
						warning = WIP_RESTORE_FAILED;
					}
				}

				let hookNotifications: Notification[] = [];
				if (input.postUpdateHooks?.length && deps.shell) {
					const hookResult = await runHooks(
						{
							commands: input.postUpdateHooks,
							context: {
								worktreePath: wt.path,
								branch: wt.branch,
								repoRoot: input.repoRoot ?? "",
								baseBranch: parent,
							},
						},
						{ shell: deps.shell },
					);
					if (hookResult.success) {
						hookNotifications = hookResult.data.notifications;
					}
				}

				reports.push({
					branch: wt.branch,
					path: wt.path,
					parent,
					retargetedFrom: retargetMap[wt.branch],
					result: { status: isDirty ? "rebased-dirty" : "rebased", warning },
					hookNotifications,
				});
			} else {
				const warnings: string[] = [];
				const abortResult = await git.rebaseAbort(wt.path);
				if (!abortResult.success) {
					warnings.push("rebase abort failed — worktree may be left mid-rebase");
				}
				if (isDirty) {
					const resetResult = await git.resetLastCommit(wt.path);
					if (!resetResult.success) {
						warnings.push(WIP_RESTORE_FAILED);
					}
				}
				reports.push({
					branch: wt.branch,
					path: wt.path,
					parent,
					retargetedFrom: retargetMap[wt.branch],
					result: {
						status: "rebase-conflict",
						message: rebaseResult.error.message,
						warning: warnings.length > 0 ? warnings.join("; ") : undefined,
					},
					hookNotifications: [],
				});
				failedBranches.add(wt.branch);
			}
		}
	}

	return R.ok({ defaultBranch, defaultBranchUpdate, syncedFromUpstream, reports });
}
