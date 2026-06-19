import type { GitPort } from "../../domain/ports/git-port.ts";
import { findCherryPickedPrefix } from "./find-cherry-picked-prefix.ts";
import { findSquashMergedPrefix } from "./find-squash-merged-prefix.ts";

export interface IsFullyMergedDeps {
	git: GitPort;
}

export interface IsFullyMergedInput {
	branch: string;
	defaultBranch: string;
}

/**
 * Returns true iff every commit ahead of defaultBranch on branch can be matched
 * to a cherry-pick (patch-id) or squash-merge (subject+files) on defaultBranch.
 * Requires ahead > 0 — for ahead === 0 we cannot prove the merge happened, so
 * returns false. Callers handle the ahead=0 ("empty") case separately.
 */
export async function isFullyMerged(input: IsFullyMergedInput, deps: IsFullyMergedDeps): Promise<boolean> {
	const { git } = deps;
	const { branch, defaultBranch } = input;

	const ahead = await git.getCommitCount(defaultBranch, branch);
	if (!ahead.success || ahead.data === 0) return false;

	const cherryPickPrefix = await findCherryPickedPrefix({ git }, { base: defaultBranch, feature: branch });
	const squashPrefix =
		cherryPickPrefix && cherryPickPrefix.skippedCount === cherryPickPrefix.totalCount
			? null
			: await findSquashMergedPrefix({ git }, { base: defaultBranch, feature: branch });
	const prefix =
		cherryPickPrefix && cherryPickPrefix.skippedCount === cherryPickPrefix.totalCount
			? cherryPickPrefix
			: (squashPrefix ?? cherryPickPrefix);

	if (prefix && prefix.skippedCount === prefix.totalCount) return true;
	return false;
}
