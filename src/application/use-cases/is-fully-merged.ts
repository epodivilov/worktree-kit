import type { GitPort } from "../../domain/ports/git-port.ts";
import { findMergedPrefix } from "./find-merged-prefix.ts";

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

	const prefix = await findMergedPrefix(
		{ git },
		{ base: defaultBranch, feature: branch },
		{ trySquashOnPartialCherryPick: true },
	);
	return prefix?.fully ?? false;
}
