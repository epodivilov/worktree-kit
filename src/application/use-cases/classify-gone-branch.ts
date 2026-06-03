import type { GitPort } from "../../domain/ports/git-port.ts";
import { findCherryPickedPrefix } from "./find-cherry-picked-prefix.ts";
import { findSquashMergedPrefix } from "./find-squash-merged-prefix.ts";

export type GoneBranchClassification = "cleanable" | "skipped-dirty" | "skipped-unmerged";

export interface ClassifyGoneBranchInput {
	branch: string;
	defaultBranch: string;
	worktreePath: string | null;
	force: boolean;
}

export interface ClassifyGoneBranchDeps {
	git: GitPort;
}

export async function classifyGoneBranch(
	input: ClassifyGoneBranchInput,
	deps: ClassifyGoneBranchDeps,
): Promise<GoneBranchClassification> {
	const { git } = deps;
	const { branch, defaultBranch, worktreePath, force } = input;

	if (worktreePath && !force) {
		const dirty = await git.isDirty(worktreePath);
		if (dirty.success && dirty.data === true) return "skipped-dirty";
	}

	if (force) return "cleanable";

	const ahead = await git.getCommitCount(defaultBranch, branch);
	if (ahead.success && ahead.data === 0) return "cleanable";

	const cherryPickPrefix = await findCherryPickedPrefix({ git }, { base: defaultBranch, feature: branch });
	const squashPrefix =
		cherryPickPrefix && cherryPickPrefix.skippedCount === cherryPickPrefix.totalCount
			? null
			: await findSquashMergedPrefix({ git }, { base: defaultBranch, feature: branch });
	const prefix =
		cherryPickPrefix && cherryPickPrefix.skippedCount === cherryPickPrefix.totalCount
			? cherryPickPrefix
			: (squashPrefix ?? cherryPickPrefix);

	if (prefix && prefix.skippedCount === prefix.totalCount) return "cleanable";

	return "skipped-unmerged";
}
