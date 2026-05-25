import { resolve } from "node:path";
import type { Worktree } from "../domain/entities/worktree.ts";

export function getExpectedWorktreePath(repoRoot: string, rootDir: string, branch: string): string {
	return resolve(repoRoot, rootDir, branch);
}

export function isDrifted(worktree: Worktree, repoRoot: string, rootDir: string): boolean {
	if (worktree.isMain) return false;
	if (!worktree.branch) return false;
	return worktree.path !== getExpectedWorktreePath(repoRoot, rootDir, worktree.branch);
}
