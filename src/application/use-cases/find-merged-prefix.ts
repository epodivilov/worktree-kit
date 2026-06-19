import type { GitPort } from "../../domain/ports/git-port.ts";
import { findCherryPickedPrefix } from "./find-cherry-picked-prefix.ts";
import { findSquashMergedPrefix } from "./find-squash-merged-prefix.ts";

export interface MergedPrefix {
	/** SHA of the last commit covered by the merged prefix — use as `git rebase --upstream=<sha>`. */
	lastSkippedCommit: string;
	skippedCount: number;
	totalCount: number;
	/** True when every commit ahead of `base` is covered by the merged prefix. */
	fully: boolean;
	method: "patch-id" | "subject" | "squash";
}

export interface FindMergedPrefixDeps {
	git: GitPort;
}

export interface FindMergedPrefixInput {
	base: string;
	feature: string;
}

/**
 * Detects how much of `feature` (the commits ahead of `base`) is already merged into `base`
 * via cherry-pick (patch-id or subject+files) or squash-merge.
 *
 * Pipeline: try cherry-pick first; only fall back to squash-merge detection when cherry-pick
 * returned nothing. This mirrors the original logic in `update-worktrees.ts` and is the
 * authoritative source for both `update-worktrees.ts` and `is-fully-merged.ts`.
 */
export async function findMergedPrefix(
	deps: FindMergedPrefixDeps,
	input: FindMergedPrefixInput,
): Promise<MergedPrefix | null> {
	const { git } = deps;
	const { base, feature } = input;

	const cherryPickPrefix = await findCherryPickedPrefix({ git }, { base, feature });
	const squashPrefix = cherryPickPrefix ? null : await findSquashMergedPrefix({ git }, { base, feature });
	const prefix = cherryPickPrefix ?? squashPrefix;

	if (!prefix) return null;

	return {
		lastSkippedCommit: prefix.lastSkippedCommit,
		skippedCount: prefix.skippedCount,
		totalCount: prefix.totalCount,
		fully: prefix.skippedCount === prefix.totalCount,
		method: prefix.method,
	};
}
