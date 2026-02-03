import type { Worktree } from "../../domain/entities/worktree.ts";
import type { GitError, GitPort } from "../../domain/ports/git-port.ts";
import { Result } from "../../shared/result.ts";

export function createBunGitAdapter(): GitPort {
	return {
		async isGitRepository(): Promise<Result<boolean, GitError>> {
			try {
				const proc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "pipe" });
				const exitCode = await proc.exited;
				return Result.ok(exitCode === 0);
			} catch {
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to check git repository",
				});
			}
		},

		async getRepositoryRoot(): Promise<Result<string, GitError>> {
			try {
				const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });
				const exitCode = await proc.exited;
				if (exitCode !== 0) {
					return Result.err({
						code: "NOT_A_REPO",
						message: "Not inside a git repository",
					});
				}
				const output = await new Response(proc.stdout).text();
				return Result.ok(output.trim());
			} catch {
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to get repository root",
				});
			}
		},

		async listWorktrees(): Promise<Result<Worktree[], GitError>> {
			return Result.ok([]);
		},

		async createWorktree(_branch: string, _path: string): Promise<Result<Worktree, GitError>> {
			return Result.err({
				code: "UNKNOWN",
				message: "Not implemented",
			});
		},

		async removeWorktree(_path: string): Promise<Result<void, GitError>> {
			return Result.err({
				code: "UNKNOWN",
				message: "Not implemented",
			});
		},
	};
}
