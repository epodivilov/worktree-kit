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

export interface FindMergedPrefixOptions {
	/**
	 * When true (default false), if cherry-pick detection returns a partial prefix
	 * (`skippedCount < totalCount`), still try squash-merge detection and prefer the
	 * squash result if it covers more commits. Use for "is this branch fully merged?"
	 * queries where we want to maximize detection.
	 *
	 * When false, follow the simpler "cherry-pick first; squash only if cherry-pick
	 * is null" pipeline. Use for rebase `--upstream` queries where the cherry-pick
	 * `lastSkippedCommit` is the load-bearing piece (a partial cherry-pick prefix is
	 * still actionable as a rebase boundary).
	 */
	trySquashOnPartialCherryPick?: boolean;
}

/**
 * Detects how much of `feature` (the commits ahead of `base`) is already merged into `base`
 * via cherry-pick (patch-id or subject+files) or squash-merge.
 *
 * Two pipelines live behind one helper; the divergence is intentional — see
 * `FindMergedPrefixOptions.trySquashOnPartialCherryPick` for which call site picks which.
 */
export async function findMergedPrefix(
	deps: FindMergedPrefixDeps,
	input: FindMergedPrefixInput,
	options: FindMergedPrefixOptions = {},
): Promise<MergedPrefix | null> {
	const { git } = deps;
	const { base, feature } = input;
	const { trySquashOnPartialCherryPick = false } = options;

	const cherryPickPrefix = await findCherryPickedPrefix({ git }, { base, feature });

	const cherryPickIsFull = cherryPickPrefix !== null && cherryPickPrefix.skippedCount === cherryPickPrefix.totalCount;

	// Skip squash detection when:
	// - cherry-pick already fully covers the branch (squash can't beat that), OR
	// - the caller picked the simple pipeline AND cherry-pick returned anything non-null
	//   (the partial cherry-pick prefix is the answer they want).
	const skipSquash = cherryPickIsFull || (!trySquashOnPartialCherryPick && cherryPickPrefix !== null);

	const squashPrefix = skipSquash ? null : await findSquashMergedPrefix({ git }, { base, feature });

	// When both detections fired (rich mode, partial cherry-pick + squash hit), prefer
	// the squash result — it's the only path that can certify "fully merged" in this
	// scenario, and it's what the original `is-fully-merged.ts` did before the unify.
	const prefix = squashPrefix ?? cherryPickPrefix;

	if (!prefix) return null;

	return {
		lastSkippedCommit: prefix.lastSkippedCommit,
		skippedCount: prefix.skippedCount,
		totalCount: prefix.totalCount,
		fully: prefix.skippedCount === prefix.totalCount,
		method: prefix.method,
	};
}
