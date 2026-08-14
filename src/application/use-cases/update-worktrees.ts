import type { Worktree } from "../../domain/entities/worktree.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { ShellPort } from "../../domain/ports/shell-port.ts";
import type { Notification } from "../../shared/notification.ts";
import { Result as R, type Result } from "../../shared/result.ts";
import { Semaphore } from "../../shared/semaphore.ts";
import { findMergedPrefix } from "./find-merged-prefix.ts";
import { isFullyMerged } from "./is-fully-merged.ts";
import { runHooks } from "./run-hooks.ts";

const WIP_RESTORE_FAILED =
	"failed to restore WIP commit — your changes are kept in a WIP commit (run 'git reset --soft HEAD~1' to unpack)";

/** Default max number of worktrees rebased at once (see `--jobs`). */
export const DEFAULT_JOBS = 4;

export interface UpdateWorktreesInput {
	dryRun: boolean;
	branch?: string;
	postUpdateHooks?: readonly string[];
	onConflictHooks?: readonly string[];
	repoRoot?: string;
	/** Name of the upstream remote to sync the default branch from (fork workflow). */
	upstream?: string;
	/** Max worktrees to rebase concurrently. Defaults to {@link DEFAULT_JOBS}. */
	jobs?: number;
}

/**
 * Live progress for the rebase phase. `begin` is called once with the full set of
 * targeted worktree branches (the display keys, including children that will be
 * skipped) before any rebasing starts; `rebasing`/`settle` fire per worktree as it
 * moves through its in-progress and terminal states. The default branch is not a
 * key and is never reported here.
 */
export interface UpdateProgressReporter {
	begin(branches: string[]): void;
	rebasing(branch: string, onto: string): void;
	settle(report: WorktreeReport): void;
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
	/**
	 * Outcome of the default-branch sync:
	 * - `"ff-updated"` / `"ref-updated"` — advanced to the remote (worktree fast-forward / ref fetch).
	 * - `"reset"` — had diverged, but every local commit was already upstream, so it was reset to the remote.
	 * - `"skipped-diverged"` — genuine local divergence (or a dirty worktree); left unchanged, the run continued.
	 * - `"would-update"` / `"would-reset"` / `"would-skip-diverged"` — dry-run previews of the above.
	 */
	defaultBranchUpdate:
		| "ff-updated"
		| "ref-updated"
		| "reset"
		| "skipped-diverged"
		| "would-update"
		| "would-reset"
		| "would-skip-diverged";
	/** Dry-run only: how many commits the default branch is behind its upstream, when it could be resolved. */
	defaultBranchBehind?: number;
	/**
	 * Remote-tracking ref (`<remote>/<branch>`) the default branch was, or would be, reset to.
	 * Set for the `reset` / `skipped-diverged` / `would-reset` / `would-skip-diverged` outcomes.
	 */
	defaultBranchRemoteRef?: string;
	/** Set to the upstream remote name when the default branch was synced from upstream. */
	syncedFromUpstream?: string;
	reports: WorktreeReport[];
}

export interface UpdateWorktreesDeps {
	git: GitPort;
	shell?: ShellPort;
	progress?: UpdateProgressReporter;
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

async function runPostUpdateHooks(
	wt: { path: string; branch: string },
	parent: string,
	input: UpdateWorktreesInput,
	deps: UpdateWorktreesDeps,
): Promise<Notification[]> {
	if (!input.postUpdateHooks?.length || !deps.shell) return [];
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
	return hookResult.success ? hookResult.data.notifications : [];
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
	// Where default-branch work happens: its own worktree when it has one, else the
	// repo root — the branch is then updated by ref and is checked out nowhere.
	const defaultBranchPath = mainWorktree?.path ?? input.repoRoot ?? "";
	let defaultBranchUpdate: UpdateWorktreesOutput["defaultBranchUpdate"];
	let defaultBranchBehind: number | undefined;
	let defaultBranchRemoteRef: string | undefined;
	let defaultBranchHookNotifications: Notification[] = [];
	let syncedFromUpstream: string | undefined;

	// Which remote is authoritative for the default branch: the configured upstream
	// (fork workflow) or the repository's primary remote. Used both as the reset target
	// and as the base for the divergence classification. Independent of whether the
	// branch happens to be checked out.
	const syncRemote = input.upstream ?? git.getPrimaryRemote();
	const remoteRef = `${syncRemote}/${defaultBranch}`;
	// True once the default branch is actually brought up to the remote (fast-forwarded
	// or reset). A skipped-diverged sync leaves it false so the run neither reports the
	// branch as synced-from-upstream nor runs its post-update hooks (R4).
	let defaultBranchSynced = false;

	if (input.dryRun) {
		// Dry run is a promise that nothing changes, so the default-branch sync is
		// skipped entirely: mergeFFOnly runs a real merge --ff-only (index + files),
		// updateBranchRef writes a local ref, and a reset mutates too. Instead, classify
		// read-only and preview the outcome. Best-effort: the primary remote name resolves
		// via getPrimaryRemote, but without a configured upstream we still key the counts
		// off the branch's tracking ref (@{u}) to match the historical preview behaviour.
		const upstreamRef = input.upstream ? `${input.upstream}/${defaultBranch}` : `${defaultBranch}@{u}`;
		const behindResult = await git.getCommitCount(defaultBranch, upstreamRef);
		const behind = behindResult.success ? behindResult.data : undefined;
		const aheadResult = await git.getCommitCount(upstreamRef, defaultBranch);
		const ahead = aheadResult.success ? aheadResult.data : undefined;

		if (ahead !== undefined && ahead > 0 && behind !== undefined && behind > 0) {
			// Ahead AND behind → diverged. Preview a would-reset when every local commit
			// is already upstream, else a would-skip. All reads, no mutation (N1).
			const fullyMerged = await isFullyMerged({ branch: defaultBranch, defaultBranch: upstreamRef }, { git });
			defaultBranchUpdate = fullyMerged ? "would-reset" : "would-skip-diverged";
			defaultBranchRemoteRef = upstreamRef;
		} else {
			defaultBranchUpdate = "would-update";
			defaultBranchBehind = behind;
		}
	} else if (mainWorktree) {
		const ffResult = input.upstream
			? await git.mergeFFOnly(mainWorktree.path, defaultBranch, input.upstream)
			: await git.mergeFFOnly(mainWorktree.path, defaultBranch);
		if (ffResult.success) {
			defaultBranchUpdate = "ff-updated";
			defaultBranchSynced = true;
		} else {
			// Fast-forward refused: the branch diverged (or the remote branch is missing /
			// the tree is dirty). Reset to the remote only when every local commit is
			// already present upstream AND the worktree is clean; otherwise leave it
			// untouched and continue the run (R2/R3/R4). The discarded commits stay
			// recoverable via reflog, which makes the silent safe-case reset acceptable.
			defaultBranchRemoteRef = remoteRef;
			const dirtyResult = await git.isDirty(mainWorktree.path);
			// On an unreadable status, assume dirty and skip — never reset over unknown state.
			const worktreeDirty = !dirtyResult.success || dirtyResult.data;
			const fullyMerged =
				!worktreeDirty && (await isFullyMerged({ branch: defaultBranch, defaultBranch: remoteRef }, { git }));
			if (fullyMerged) {
				const resetResult = await git.resetHardToRemote(mainWorktree.path, defaultBranch, syncRemote);
				if (resetResult.success) {
					defaultBranchUpdate = "reset";
					defaultBranchSynced = true;
				} else {
					defaultBranchUpdate = "skipped-diverged";
				}
			} else {
				defaultBranchUpdate = "skipped-diverged";
			}
		}
	} else {
		// Same remote as the fast-forward path above: which remote is authoritative for
		// the default branch must not depend on whether it happens to be checked out.
		const refResult = input.upstream
			? await git.updateBranchRef(defaultBranch, input.upstream)
			: await git.updateBranchRef(defaultBranch);
		if (refResult.success) {
			defaultBranchUpdate = "ref-updated";
			defaultBranchSynced = true;
		} else {
			// Same divergence handling on the ref path (default branch checked out
			// nowhere). No working tree, so no dirty guard — a fully-merged divergence
			// force-updates the ref; a genuine one is skipped (R2/R4/R5).
			defaultBranchRemoteRef = remoteRef;
			const fullyMerged = await isFullyMerged({ branch: defaultBranch, defaultBranch: remoteRef }, { git });
			if (fullyMerged) {
				const forceResult = await git.forceUpdateBranchRef(defaultBranch, syncRemote);
				if (forceResult.success) {
					defaultBranchUpdate = "reset";
					defaultBranchSynced = true;
				} else {
					defaultBranchUpdate = "skipped-diverged";
				}
			} else {
				defaultBranchUpdate = "skipped-diverged";
			}
		}
	}

	// When syncing the default branch from an upstream remote AND the sync actually
	// completed (fast-forward or reset), run post-update hooks for the default branch
	// too (mirrors the feature-branch path). Skipped in dry-run, and when the sync was
	// left undone (diverged/dirty) — there is then no completed sync to react to or
	// report, so `syncedFromUpstream` stays unset and no default-branch hooks run (R4).
	if (input.upstream && !input.dryRun && defaultBranchSynced) {
		syncedFromUpstream = input.upstream;
		if (defaultBranchPath) {
			defaultBranchHookNotifications = await runPostUpdateHooks(
				{ path: defaultBranchPath, branch: defaultBranch },
				`${input.upstream}/${defaultBranch}`,
				input,
				deps,
			);
		}
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

	// The default branch is reported when it has a worktree; without one there is
	// nothing to rebase, but hook results still need somewhere to surface.
	if (mainWorktree || defaultBranchHookNotifications.length > 0) {
		reports.push({
			branch: defaultBranch,
			path: defaultBranchPath,
			result: { status: "is-default-branch" },
			hookNotifications: defaultBranchHookNotifications,
		});
	}

	// Rebase one worktree onto its parent and return its terminal report. Mutates
	// `failedBranches` for every non-success outcome so that descendants scheduled
	// after this worktree completes see the failure. The bounded section (the git
	// mutations) is guarded by the semaphore; the cheap "parent already failed" skip
	// is decided before taking a permit so a skipped branch never occupies a slot.
	const processWorktree = async (wt: Worktree): Promise<WorktreeReport> => {
		const parent = parentMap[wt.branch] ?? defaultBranch;
		const retargetedFrom = retargetMap[wt.branch];
		const base = { branch: wt.branch, path: wt.path, parent, retargetedFrom };

		if (failedBranches.has(parent)) {
			failedBranches.add(wt.branch);
			return { ...base, result: { status: "skipped", reason: `parent ${parent} failed` }, hookNotifications: [] };
		}

		await sem.acquire();
		try {
			const dirtyResult = await git.isDirty(wt.path);
			if (!dirtyResult.success) {
				failedBranches.add(wt.branch);
				return {
					...base,
					result: { status: "rebase-conflict", message: "Could not check worktree status" },
					hookNotifications: [],
				};
			}

			const isDirty = dirtyResult.data;

			if (input.dryRun) {
				return { ...base, result: { status: "dry-run", dirty: isDirty }, hookNotifications: [] };
			}

			if (isDirty) {
				const stageResult = await git.stageAll(wt.path);
				if (!stageResult.success) {
					failedBranches.add(wt.branch);
					return {
						...base,
						result: { status: "rebase-conflict", message: "Failed to stage changes for WIP commit" },
						hookNotifications: [],
					};
				}
				const wipResult = await git.commitWip(wt.path);
				if (!wipResult.success) {
					failedBranches.add(wt.branch);
					return {
						...base,
						result: { status: "rebase-conflict", message: "Failed to create WIP commit" },
						hookNotifications: [],
					};
				}
			}

			const prefix = await findMergedPrefix(
				{ git },
				{ base: parent, feature: wt.branch },
				{ trySquashOnPartialCherryPick: false },
			);

			if (prefix?.fully) {
				if (isDirty) {
					const resetResult = await git.resetLastCommit(wt.path);
					if (!resetResult.success) {
						failedBranches.add(wt.branch);
						return {
							...base,
							result: {
								status: "rebase-conflict",
								message: "Failed to restore WIP commit after fully-merged detection",
							},
							hookNotifications: [],
						};
					}
				}
				return { ...base, result: { status: "skipped", reason: "fully merged" }, hookNotifications: [] };
			}

			deps.progress?.rebasing(wt.branch, parent);
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

				const hookNotifications = await runPostUpdateHooks(wt, parent, input, deps);

				return {
					...base,
					result: { status: isDirty ? "rebased-dirty" : "rebased", warning },
					hookNotifications,
				};
			}

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

				const hookNotifications = await runPostUpdateHooks(wt, parent, input, deps);

				return {
					...base,
					result: { status: isDirty ? "rebased-dirty" : "rebased", warning },
					hookNotifications,
				};
			}

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
			failedBranches.add(wt.branch);
			return {
				...base,
				result: {
					status: "rebase-conflict",
					message: rebaseResult.error.message,
					warning: warnings.length > 0 ? warnings.join("; ") : undefined,
				},
				hookNotifications: [],
			};
		} finally {
			sem.release();
		}
	};

	// Bounded, dependency-aware parallel scheduler. Independent subtrees rebase
	// concurrently (up to `jobs`), but a child never starts before its parent's
	// terminal report — and therefore its `failedBranches` write — is recorded.
	// Concurrency is safe only because JS is single-threaded and a child is scheduled
	// strictly after its parent's `done` promise resolves.
	const sem = new Semaphore(Math.max(1, Math.trunc(input.jobs ?? DEFAULT_JOBS)));

	deps.progress?.begin(targetWorktrees.map((wt) => wt.branch));

	const doneResolvers = new Map<string, () => void>();
	const doneByBranch = new Map<string, Promise<void>>();
	for (const wt of targetWorktrees) {
		doneByBranch.set(wt.branch, new Promise<void>((resolve) => doneResolvers.set(wt.branch, resolve)));
	}

	const reportByBranch = new Map<string, WorktreeReport>();

	await Promise.all(
		targetWorktrees.map(async (wt) => {
			try {
				// Wait for the parent only when it is part of this run. A parent outside
				// the targeted set was never processed, so it cannot have failed here.
				const parent = parentMap[wt.branch] ?? defaultBranch;
				const parentDone = doneByBranch.get(parent);
				if (parentDone) {
					await parentDone;
				}

				const report = await processWorktree(wt);
				reportByBranch.set(wt.branch, report);
				deps.progress?.settle(report);
			} finally {
				doneResolvers.get(wt.branch)?.();
			}
		}),
	);

	// Emit reports in deterministic BFS order regardless of completion order.
	for (const wt of targetWorktrees) {
		const report = reportByBranch.get(wt.branch);
		if (report) reports.push(report);
	}

	return R.ok({
		defaultBranch,
		defaultBranchUpdate,
		defaultBranchBehind,
		defaultBranchRemoteRef,
		syncedFromUpstream,
		reports,
	});
}
