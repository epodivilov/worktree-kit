import type { UiPort } from "../domain/ports/ui-port.ts";

/** Minimal shape needed to render a locked worktree in the warn group. */
export interface LockedWorktree {
	/** Branch name, or empty string for a detached worktree. */
	branch: string;
	path: string;
}

/** Display name used in remove/cleanup output: branch, or `<detached> (path)`. */
function worktreeDisplayName(wt: LockedWorktree): string {
	return wt.branch || `<detached> (${wt.path})`;
}

/**
 * Emit a single warn group for worktrees skipped because they are locked.
 *
 * A locked worktree is an expected, benign state (another task holds it), not a
 * removal failure. Rather than N red errors repeating the same instruction, this
 * renders one calm block: a count header, one entry per worktree (its name plus a
 * copy-paste `git worktree unlock "<path>"` line), and a closing re-run hint.
 *
 * Shared by `wt remove` (WTK-62) and `wt cleanup` (WTK-63); the latter passes its
 * own `rerunCommand`. No-op when nothing was skipped.
 */
export function warnLockedWorktreesGroup(
	ui: Pick<UiPort, "warn">,
	locked: LockedWorktree[],
	rerunCommand = "wt remove",
): void {
	if (locked.length === 0) return;

	const count = locked.length;
	const noun = count === 1 ? "worktree" : "worktrees";
	const verb = count === 1 ? "it is" : "they are";
	const header = `${count} ${noun} skipped because ${verb} locked by another task:`;

	const entries = locked.map((wt) => `  ${worktreeDisplayName(wt)}\n    git worktree unlock "${wt.path}"`);

	const footer = `Unlock the ones you want to remove, then re-run ${rerunCommand}.`;

	ui.warn(`${header}\n\n${entries.join("\n\n")}\n\n${footer}`);
}
