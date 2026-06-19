import type { GitPort } from "../../domain/ports/git-port.ts";
import { isFullyMerged } from "./is-fully-merged.ts";

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
		if (await isFullyMerged({ branch, defaultBranch }, { git })) return "merged";
		return "skipped-unmerged";
	}

	if (ahead.success && ahead.data === 0) return "empty";

	// ahead lookup failed — be conservative.
	return "skipped-unmerged";
}
