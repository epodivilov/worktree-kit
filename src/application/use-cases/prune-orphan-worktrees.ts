import type { GitPort } from "../../domain/ports/git-port.ts";

export interface PruneOrphanWorktreesInput {
	paths: readonly string[];
	dryRun?: boolean;
}

export type PruneOrphanStatus = "pruned" | "dry-run" | "error";

export interface PruneOrphanReport {
	worktreePath: string;
	status: PruneOrphanStatus;
	message?: string;
}

export interface PruneOrphanWorktreesOutput {
	reports: readonly PruneOrphanReport[];
}

export interface PruneOrphanWorktreesDeps {
	git: GitPort;
}

export async function pruneOrphanWorktrees(
	input: PruneOrphanWorktreesInput,
	deps: PruneOrphanWorktreesDeps,
): Promise<PruneOrphanWorktreesOutput> {
	const { git } = deps;
	const reports: PruneOrphanReport[] = [];

	for (const worktreePath of input.paths) {
		if (input.dryRun) {
			reports.push({ worktreePath, status: "dry-run" });
			continue;
		}

		const result = await git.pruneWorktree(worktreePath);
		if (result.success) {
			reports.push({ worktreePath, status: "pruned" });
		} else {
			reports.push({ worktreePath, status: "error", message: result.error.message });
		}
	}

	return { reports };
}
