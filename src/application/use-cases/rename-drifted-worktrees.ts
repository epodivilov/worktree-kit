import type { GitPort } from "../../domain/ports/git-port.ts";

export interface DriftedWorktreeMove {
	from: string;
	to: string;
	branch: string;
}

export interface RenameDriftedWorktreesInput {
	moves: readonly DriftedWorktreeMove[];
	dryRun?: boolean;
}

export type RenameDriftedStatus = "renamed" | "dry-run" | "error";

export interface RenameDriftedReport {
	from: string;
	to: string;
	branch: string;
	status: RenameDriftedStatus;
	message?: string;
}

export interface RenameDriftedWorktreesOutput {
	reports: readonly RenameDriftedReport[];
}

export interface RenameDriftedWorktreesDeps {
	git: GitPort;
}

export async function renameDriftedWorktrees(
	input: RenameDriftedWorktreesInput,
	deps: RenameDriftedWorktreesDeps,
): Promise<RenameDriftedWorktreesOutput> {
	const { git } = deps;
	const reports: RenameDriftedReport[] = [];

	for (const move of input.moves) {
		const { from, to, branch } = move;

		if (input.dryRun) {
			reports.push({ from, to, branch, status: "dry-run" });
			continue;
		}

		const result = await git.moveWorktree(from, to);
		if (result.success) {
			reports.push({ from, to, branch, status: "renamed" });
		} else {
			reports.push({ from, to, branch, status: "error", message: result.error.message });
		}
	}

	return { reports };
}
