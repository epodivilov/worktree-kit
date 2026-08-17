import type { Worktree } from "../../domain/entities/worktree.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { ShellPort } from "../../domain/ports/shell-port.ts";
import type { Notification } from "../../shared/notification.ts";
import { Result as R, type Result } from "../../shared/result.ts";
import { Semaphore, withPermit } from "../../shared/semaphore.ts";
import { findMergedPrefix } from "./find-merged-prefix.ts";
import { isFullyMerged } from "./is-fully-merged.ts";
import { runHooks } from "./run-hooks.ts";

const WIP_RESTORE_FAILED =
	"failed to restore WIP commit — your changes are kept in a WIP commit (run 'git reset --soft HEAD~1' to unpack)";

/** Default max number of worktrees rebased at once (see `--jobs`). */
export const DEFAULT_JOBS = 4;

/**
 * Max base-resolution git probes (merge-base / commit-count) in flight at once
 * (WTK-66). Internal, not a CLI knob: it bounds read-only reads, distinct from
 * `--jobs`, which bounds rebase writes. Keeps a busy-upstream fork from spawning
 * hundreds of `git` processes at once while still overlapping the independent probes.
 */
export const DEFAULT_PROBE_CONCURRENCY = 16;

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

/**
 * Per-root sync outcome (WTK-64). One is produced for the default branch and for
 * every other local root (a branch whose same name exists on the upstream remote).
 * The `update` variants mirror the default-branch outcomes so the CLI renders each
 * root the same way.
 */
export interface RootSyncReport {
	branch: string;
	update:
		| "ff-updated"
		| "ref-updated"
		| "reset"
		| "skipped-diverged"
		| "would-update"
		| "would-reset"
		| "would-skip-diverged";
	/** Dry-run only: commits the root is behind its upstream, when resolvable. */
	behind?: number;
	/** `<remote>/<branch>` the root was, or would be, reset to (reset / skip / would-* outcomes). */
	remoteRef?: string;
	/** Upstream remote name when the root was actually synced from upstream. */
	syncedFromUpstream?: string;
	/**
	 * Post-update hook results for a checked-out non-default root that was synced
	 * (WTK-64). The default branch surfaces its hooks via its is-default-branch
	 * report instead; a ref-only root (checked out nowhere) has no worktree to run
	 * hooks in, so this stays unset for it.
	 */
	hookNotifications?: Notification[];
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
	/**
	 * Sync outcome for every NON-default local root (WTK-64). The default branch's
	 * outcome stays on the `defaultBranch*` fields above; these are the extra roots
	 * a fork syncs from their own `<upstream>/<name>`. Empty when there is a single
	 * root (no upstream, or upstream has no other same-named local branch).
	 */
	rootSyncs: RootSyncReport[];
	reports: WorktreeReport[];
}

export interface UpdateWorktreesDeps {
	git: GitPort;
	shell?: ShellPort;
	progress?: UpdateProgressReporter;
}

/**
 * A "root" branch feature branches rebase toward (WTK-64). The default branch is
 * always a root; with an upstream remote, every other same-named branch on it is
 * one too. A `local` root has a local branch — it is synced and used as a base by
 * name; an absent root lives only on the upstream remote and is a rebase target
 * via its `<upstream>/<name>` ref.
 */
interface Root {
	name: string;
	local: boolean;
	/** Ref features rebase onto: the local branch name, or `<upstream>/<name>` for an absent root. */
	base: string;
	/** Worktree path when a local root is checked out; decides fast-forward vs. ref update. */
	worktreePath?: string;
}

/**
 * Sync a single LOCAL root from its upstream, applying the WTK-61 divergence
 * handling (R5). Fast-forwards when the root is checked out, else updates its ref
 * in place; on a refused fast-forward it resets to the remote when every local
 * commit is already upstream AND the worktree is clean, otherwise leaves the root
 * untouched and continues. Dry-run mutates nothing and previews the outcome.
 * Absent (upstream-only) roots are never passed here — they cannot diverge.
 */
async function syncRoot(
	root: { name: string; worktreePath?: string },
	input: UpdateWorktreesInput,
	git: GitPort,
): Promise<{ report: RootSyncReport; synced: boolean }> {
	const { name } = root;
	// Which remote is authoritative for this root — the configured upstream (fork
	// workflow) or the primary remote — independent of whether it is checked out.
	const syncRemote = input.upstream ?? git.getPrimaryRemote();
	const remoteRef = `${syncRemote}/${name}`;

	if (input.dryRun) {
		// A dry run promises nothing changes, so classify read-only and preview.
		// Without a configured upstream the counts key off the tracking ref (@{u}).
		const upstreamRef = input.upstream ? `${input.upstream}/${name}` : `${name}@{u}`;
		const behindResult = await git.getCommitCount(name, upstreamRef);
		const behind = behindResult.success ? behindResult.data : undefined;
		const aheadResult = await git.getCommitCount(upstreamRef, name);
		const ahead = aheadResult.success ? aheadResult.data : undefined;

		if (ahead !== undefined && ahead > 0 && behind !== undefined && behind > 0) {
			const fullyMerged = await isFullyMerged({ branch: name, defaultBranch: upstreamRef }, { git });
			return {
				report: { branch: name, update: fullyMerged ? "would-reset" : "would-skip-diverged", remoteRef },
				synced: false,
			};
		}
		return { report: { branch: name, update: "would-update", behind }, synced: false };
	}

	if (root.worktreePath) {
		const ffResult = input.upstream
			? await git.mergeFFOnly(root.worktreePath, name, input.upstream)
			: await git.mergeFFOnly(root.worktreePath, name);
		if (ffResult.success) {
			return { report: { branch: name, update: "ff-updated" }, synced: true };
		}
		// Fast-forward refused → diverged (or dirty). Reset only when every local
		// commit is already upstream AND the tree is clean; else leave it and warn.
		const dirtyResult = await git.isDirty(root.worktreePath);
		const worktreeDirty = !dirtyResult.success || dirtyResult.data;
		const canReset = !worktreeDirty && (await isFullyMerged({ branch: name, defaultBranch: remoteRef }, { git }));
		if (canReset) {
			const resetResult = await git.resetHardToRemote(root.worktreePath, name, syncRemote);
			if (resetResult.success) {
				return { report: { branch: name, update: "reset", remoteRef }, synced: true };
			}
		}
		return { report: { branch: name, update: "skipped-diverged", remoteRef }, synced: false };
	}

	const refResult = input.upstream ? await git.updateBranchRef(name, input.upstream) : await git.updateBranchRef(name);
	if (refResult.success) {
		return { report: { branch: name, update: "ref-updated" }, synced: true };
	}
	// Ref path (root checked out nowhere): no working tree, so no dirty guard — a
	// fully-merged divergence force-updates the ref; a genuine one is skipped.
	const fullyMerged = await isFullyMerged({ branch: name, defaultBranch: remoteRef }, { git });
	if (fullyMerged) {
		const forceResult = await git.forceUpdateBranchRef(name, syncRemote);
		if (forceResult.success) {
			return { report: { branch: name, update: "reset", remoteRef }, synced: true };
		}
	}
	return { report: { branch: name, update: "skipped-diverged", remoteRef }, synced: false };
}

/**
 * Distance from `candidateRef`'s tip to `branch` when `candidateRef` is a TRUE
 * ancestor of `branch` (the branch fully contains the candidate's tip), else null.
 * Ancestor test: `merge-base(branch, candidate) === candidate.tip`, i.e. the
 * candidate has no commits beyond the merge-base. This is what excludes a sibling
 * that merely shares a common base (R4). Returns null on missing git data or when
 * the branch has no commits past the candidate (distance 0).
 */
async function ancestorDistance(git: GitPort, branch: string, candidateRef: string): Promise<number | null> {
	const mergeBase = await git.getMergeBase(branch, candidateRef);
	if (!mergeBase.success) return null;
	const distance = await git.getCommitCount(mergeBase.data, branch);
	if (!distance.success || distance.data === 0) return null;
	const candidateAhead = await git.getCommitCount(mergeBase.data, candidateRef);
	if (!candidateAhead.success || candidateAhead.data !== 0) return null;
	return distance.data;
}

/**
 * Merge-base distance: how many commits `branch` carries past its common ancestor
 * with `ref`. Returns null when there is no shared history, or when `branch` has
 * nothing past the merge-base (distance 0).
 *
 * Unlike {@link ancestorDistance} this does NOT require `ref` to be a true ancestor.
 * It is used for ROOTS, whose identity is structural — a name on the upstream
 * remote — not ancestral. A root that has advanced past `branch`'s fork point (its
 * upstream moved, or `fetch` advanced its remote-tracking ref) is no longer a strict
 * ancestor of `branch`, yet it is still `branch`'s base and must stay eligible
 * (R2 local root, R3 absent root). The strict ancestor test is reserved for sibling
 * worktree branches, where it correctly excludes a non-ancestor sibling (R4).
 */
async function mergeBaseDistance(git: GitPort, branch: string, ref: string): Promise<number | null> {
	const mergeBase = await git.getMergeBase(branch, ref);
	if (!mergeBase.success) return null;
	const distance = await git.getCommitCount(mergeBase.data, branch);
	if (!distance.success || distance.data === 0) return null;
	return distance.data;
}

async function findParentBranch(
	branch: string,
	worktrees: Worktree[],
	defaultBranch: string,
	roots: Root[],
	localRootNames: Set<string>,
	goneSet: Set<string>,
	git: GitPort,
	probeSem: Semaphore,
): Promise<{ parent: string; retargetedFrom?: string }> {
	// The candidate slots below are probed CONCURRENTLY under `probeSem`, but their
	// results are reassembled in a fixed order — default, then roots in discovery
	// order, then siblings in worktree order — before the sort, so probe-completion
	// order never leaks into the equal-distance tie-break (WTK-66 R3).

	// The default branch is the always-available fallback base; it is not put through
	// the strict ancestor filter (R6-compatible with the original logic). A distance of
	// 0 means the branch is fully contained by the default and short-circuits to it.
	const defaultProbe = withPermit(probeSem, async (): Promise<"none" | "contained" | { distance: number }> => {
		const mergeBase = await git.getMergeBase(branch, defaultBranch);
		if (!mergeBase.success) return "none";
		const count = await git.getCommitCount(mergeBase.data, branch);
		if (!count.success) return "none";
		if (count.data === 0) return "contained";
		return { distance: count.data };
	});

	// Non-default roots (local branches or upstream-only refs). A root is a base by
	// STRUCTURE — its name exists on the upstream remote — not by ancestry, so it is
	// matched by merge-base nearness like the default branch above. A root that
	// advanced past this branch's fork point (its upstream moved, or `fetch` advanced
	// its remote-tracking ref) is no longer a strict ancestor but is still this
	// branch's base and must stay eligible (R2 local, R3 absent). The strict ancestor
	// filter is reserved for the sibling worktree branches below. Roots never go gone.
	const nonDefaultRoots = roots.filter((root) => root.name !== defaultBranch);
	const rootProbes = Promise.all(
		nonDefaultRoots.map((root) => withPermit(probeSem, () => mergeBaseDistance(git, branch, root.base))),
	);

	// Other worktree branches. The same true-ancestor rule now also excludes a
	// non-ancestor sibling that merely shares a common base with the branch (R4).
	const siblings = worktrees.filter((wt) => wt.branch && wt.branch !== branch && !localRootNames.has(wt.branch));
	const siblingProbes = Promise.all(
		siblings.map((wt) => withPermit(probeSem, () => ancestorDistance(git, branch, wt.branch))),
	);

	const [defaultResult, rootDistances, siblingDistances] = await Promise.all([defaultProbe, rootProbes, siblingProbes]);

	// The old sequential code returned here — feature fully contained in the default —
	// BEFORE probing any root or sibling. We deliberately launch all probes eagerly
	// above so the default probe overlaps the root/sibling probes (the overlap the
	// concurrency win relies on, asserted by the R1 tests); a fully-contained feature
	// therefore runs a few extra bounded, concurrent reads. Do not reinstate a
	// default-only early return before the probe launch without re-checking those tests.
	if (defaultResult === "contained") {
		return { parent: defaultBranch };
	}

	const candidates: { branch: string; distance: number; gone: boolean }[] = [];
	if (defaultResult !== "none") {
		candidates.push({ branch: defaultBranch, distance: defaultResult.distance, gone: false });
	}
	nonDefaultRoots.forEach((root, index) => {
		const distance = rootDistances[index];
		if (distance !== null && distance !== undefined) {
			candidates.push({ branch: root.base, distance, gone: false });
		}
	});
	siblings.forEach((wt, index) => {
		const distance = siblingDistances[index];
		if (distance !== null && distance !== undefined) {
			candidates.push({ branch: wt.branch, distance, gone: goneSet.has(wt.branch) });
		}
	});

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

function buildRebaseOrder(
	worktrees: Worktree[],
	parentMap: Record<string, string>,
	defaultBranch: string,
	rootBases: Set<string>,
	localRootNames: Set<string>,
): Worktree[] {
	const children = new Map<string, string[]>();
	for (const wt of worktrees) {
		if (!wt.branch || localRootNames.has(wt.branch)) continue;
		const parent = parentMap[wt.branch] ?? defaultBranch;
		const siblings = children.get(parent);
		if (siblings) {
			siblings.push(wt.branch);
		} else {
			children.set(parent, [wt.branch]);
		}
	}

	const ordered: string[] = [];
	// Seed the BFS with every root base so a descendant of a non-default root waits
	// for that root, and roots themselves are never emitted for rebasing.
	const queue: string[] = [...rootBases];

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) break;
		if (!rootBases.has(current)) {
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

	// Discover the roots (WTK-64). The default branch is always a root; with an
	// upstream remote, every other same-named branch on it is a root too — local
	// when a local branch of that name exists (synced + used as a base by name),
	// otherwise absent (a rebase target via its `<upstream>/<name>` ref, never
	// synced and never created locally).
	const worktreeByBranch = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch, w] as const));
	const roots: Root[] = [{ name: defaultBranch, local: true, base: defaultBranch, worktreePath: mainWorktree?.path }];
	if (input.upstream) {
		const localBranchesResult = await git.listBranches();
		const localBranches = new Set(localBranchesResult.success ? localBranchesResult.data : []);
		const upstreamBranchesResult = await git.listRemoteBranchesFor(input.upstream);
		// ignored: on failure no extra roots are discovered — the default stays the only root.
		const upstreamBranches = upstreamBranchesResult.success ? upstreamBranchesResult.data : [];
		for (const name of upstreamBranches) {
			if (name === defaultBranch) continue;
			const local = localBranches.has(name);
			roots.push({
				name,
				local,
				base: local ? name : `${input.upstream}/${name}`,
				worktreePath: local ? worktreeByBranch.get(name)?.path : undefined,
			});
		}
	}
	const localRootNames = new Set(roots.filter((r) => r.local).map((r) => r.name));
	const rootBases = new Set(roots.map((r) => r.base));

	// Sync every LOCAL root from its own upstream (R1), each with the WTK-61
	// divergence handling (R5). Absent roots are rebase targets only and cannot
	// diverge, so they are skipped here.
	const rootSyncByName = new Map<string, { report: RootSyncReport; synced: boolean }>();
	for (const root of roots) {
		if (!root.local) continue;
		const result = await syncRoot(root, input, git);
		if (input.upstream && !input.dryRun && result.synced) {
			result.report.syncedFromUpstream = input.upstream;
			// A non-default root runs its post-update hooks here; the default branch
			// runs them below and surfaces them via its is-default-branch report. Only a
			// checked-out root has a worktree to run hooks in.
			if (root.name !== defaultBranch && root.worktreePath) {
				result.report.hookNotifications = await runPostUpdateHooks(
					{ path: root.worktreePath, branch: root.name },
					`${input.upstream}/${root.name}`,
					input,
					deps,
				);
			}
		}
		rootSyncByName.set(root.name, result);
	}

	const defaultSync = rootSyncByName.get(defaultBranch);
	if (!defaultSync) {
		// Unreachable: the default branch is always the first local root.
		return R.err(new Error("internal error: default branch was not synced"));
	}
	const defaultBranchUpdate = defaultSync.report.update;
	const defaultBranchBehind = defaultSync.report.behind;
	const defaultBranchRemoteRef = defaultSync.report.remoteRef;
	const syncedFromUpstream = defaultSync.report.syncedFromUpstream;
	const defaultBranchSynced = defaultSync.synced;
	// Non-default local roots, in discovery order, for the CLI's per-root summary.
	const rootSyncs = roots
		.filter((r) => r.local && r.name !== defaultBranch)
		.map((r) => rootSyncByName.get(r.name)?.report)
		.filter((report): report is RootSyncReport => report !== undefined);

	// When the default branch was actually synced from an upstream remote, run its
	// post-update hooks too (mirrors the feature-branch path). Skipped in dry-run and
	// when the sync was left undone (diverged/dirty) — `syncedFromUpstream` then stays
	// unset and no default-branch hooks run (R4).
	let defaultBranchHookNotifications: Notification[] = [];
	if (input.upstream && !input.dryRun && defaultBranchSynced && defaultBranchPath) {
		defaultBranchHookNotifications = await runPostUpdateHooks(
			{ path: defaultBranchPath, branch: defaultBranch },
			`${input.upstream}/${defaultBranch}`,
			input,
			deps,
		);
	}

	// Resolve every feature's rebase base (WTK-66). This is a pure read phase with no
	// inter-feature ordering dependency, so features resolve CONCURRENTLY and each
	// feature's own per-candidate probes overlap too — all bounded by one shared probe
	// semaphore. Every feature writes only its own `parentMap` / `retargetMap` keys
	// (safe under single-threaded JS), and the `Promise.all` barrier below guarantees
	// resolution is fully complete before `buildRebaseOrder` consumes `parentMap`.
	const parentMap: Record<string, string> = {};
	const retargetMap: Record<string, string> = {};
	const probeSem = new Semaphore(DEFAULT_PROBE_CONCURRENCY);
	// Roots are never rebased — they are synced above and serve as bases.
	const featureWorktrees = worktrees.filter((wt) => wt.branch && !localRootNames.has(wt.branch));
	await Promise.all(
		featureWorktrees.map(async (wt) => {
			const resolved = await findParentBranch(
				wt.branch,
				worktrees,
				defaultBranch,
				roots,
				localRootNames,
				goneSet,
				git,
				probeSem,
			);
			parentMap[wt.branch] = resolved.parent;
			if (resolved.retargetedFrom) {
				retargetMap[wt.branch] = resolved.retargetedFrom;
			}
		}),
	);

	const orderedWorktrees = buildRebaseOrder(worktrees, parentMap, defaultBranch, rootBases, localRootNames);

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
		rootSyncs,
		reports,
	});
}
