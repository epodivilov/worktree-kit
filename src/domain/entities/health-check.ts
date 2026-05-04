export type HealthSeverity = "error" | "warning" | "info";

export type HealthIssue =
	| { type: "broken-symlink"; severity: "error"; path: string; worktreePath: string }
	| { type: "rebase-in-progress"; severity: "error"; worktreePath: string; branch: string }
	| { type: "merge-in-progress"; severity: "error"; worktreePath: string; branch: string }
	| { type: "config-ref-missing"; severity: "error"; path: string; field: "copy" | "symlinks" }
	| { type: "missing-worktree-directory"; severity: "error"; worktreePath: string; branch: string }
	| { type: "empty-prefix-directory"; severity: "warning"; path: string }
	| { type: "dirty-worktree"; severity: "info"; worktreePath: string; branch: string };

export interface HealthReport {
	readonly issues: readonly HealthIssue[];
	readonly healthy: boolean;
}
