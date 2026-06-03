import type { GitPort } from "../../domain/ports/git-port.ts";
import { findCherryPickedPrefix } from "./find-cherry-picked-prefix.ts";
import { findSquashMergedPrefix } from "./find-squash-merged-prefix.ts";

export type GoneBranchClassification = "merged" | "empty" | "skipped-unmerged" | "skipped-dirty";

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

	// Forced cleanup is a strong "go" — treat as merged for downstream actions.
	if (force) return "merged";

	const ahead = await git.getCommitCount(defaultBranch, branch);

	if (ahead.success && ahead.data > 0) {
		const cherryPickPrefix = await findCherryPickedPrefix({ git }, { base: defaultBranch, feature: branch });
		const squashPrefix =
			cherryPickPrefix && cherryPickPrefix.skippedCount === cherryPickPrefix.totalCount
				? null
				: await findSquashMergedPrefix({ git }, { base: defaultBranch, feature: branch });
		const prefix =
			cherryPickPrefix && cherryPickPrefix.skippedCount === cherryPickPrefix.totalCount
				? cherryPickPrefix
				: (squashPrefix ?? cherryPickPrefix);

		if (prefix && prefix.skippedCount === prefix.totalCount) return "merged";
		return "skipped-unmerged";
	}

	if (ahead.success && ahead.data === 0) return "empty";

	// ahead lookup failed — be conservative.
	return "skipped-unmerged";
}
