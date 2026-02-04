import { dirname } from "node:path";
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

		async getMainWorktreeRoot(): Promise<Result<string, GitError>> {
			try {
				const proc = Bun.spawn(["git", "rev-parse", "--git-common-dir"], { stdout: "pipe", stderr: "pipe" });
				const exitCode = await proc.exited;
				if (exitCode !== 0) {
					return Result.err({
						code: "NOT_A_REPO",
						message: "Not inside a git repository",
					});
				}
				const gitCommonDir = (await new Response(proc.stdout).text()).trim();

				// In main worktree: returns ".git"
				// In linked worktree: returns absolute path like "/path/to/main/.git"
				if (gitCommonDir === ".git") {
					return this.getRepositoryRoot();
				}

				// For linked worktree, parent of .git is the main worktree root
				return Result.ok(dirname(gitCommonDir));
			} catch {
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to get main worktree root",
				});
			}
		},

		async listWorktrees(): Promise<Result<Worktree[], GitError>> {
			try {
				const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], { stdout: "pipe", stderr: "pipe" });
				const exitCode = await proc.exited;
				if (exitCode !== 0) {
					return Result.err({
						code: "NOT_A_REPO",
						message: "Not inside a git repository",
					});
				}
				const output = await new Response(proc.stdout).text();
				return Result.ok(parseWorktreesPorcelain(output));
			} catch {
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to list worktrees",
				});
			}
		},

		async branchExists(branch: string): Promise<Result<boolean, GitError>> {
			try {
				const proc = Bun.spawn(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const exitCode = await proc.exited;
				return Result.ok(exitCode === 0);
			} catch {
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to check branch existence",
				});
			}
		},

		async createWorktree(branch: string, path: string): Promise<Result<Worktree, GitError>> {
			try {
				const existsResult = await this.branchExists(branch);
				if (!existsResult.success) {
					return Result.err(existsResult.error);
				}

				const args = existsResult.data
					? ["git", "worktree", "add", path, branch]
					: ["git", "worktree", "add", "-b", branch, path];

				const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
				const exitCode = await proc.exited;
				if (exitCode !== 0) {
					const stderr = await new Response(proc.stderr).text();
					return Result.err(mapCreateError(stderr));
				}

				const headProc = Bun.spawn(["git", "-C", path, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
				await headProc.exited;
				const head = (await new Response(headProc.stdout).text()).trim();

				return Result.ok({ path, branch, head, isMain: false });
			} catch {
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to create worktree",
				});
			}
		},

		async removeWorktree(path: string): Promise<Result<void, GitError>> {
			try {
				const proc = Bun.spawn(["git", "worktree", "remove", path], { stdout: "pipe", stderr: "pipe" });
				const exitCode = await proc.exited;
				if (exitCode !== 0) {
					const stderr = await new Response(proc.stderr).text();
					return Result.err({
						code: stderr.toLowerCase().includes("not a git repository") ? "NOT_A_REPO" : "UNKNOWN",
						message: stderr.trim() || "Failed to remove worktree",
					});
				}
				return Result.ok(undefined);
			} catch {
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to remove worktree",
				});
			}
		},
	};
}

function parseWorktreesPorcelain(output: string): Worktree[] {
	const blocks = output.trim().split("\n\n").filter(Boolean);

	return blocks.map((block, index) => {
		const lines = block.split("\n");

		let path = "";
		let head = "";
		let branch = "";

		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				path = line.slice("worktree ".length);
			} else if (line.startsWith("HEAD ")) {
				head = line.slice("HEAD ".length);
			} else if (line.startsWith("branch ")) {
				branch = line.slice("branch ".length).replace("refs/heads/", "");
			}
		}

		return { path, branch, head, isMain: index === 0 };
	});
}

function mapCreateError(stderr: string): GitError {
	const lower = stderr.toLowerCase();

	if (
		lower.includes("already checked out") ||
		lower.includes("already used by worktree") ||
		lower.includes("a branch named")
	) {
		return { code: "BRANCH_EXISTS", message: stderr.trim() };
	}
	if (lower.includes("already exists")) {
		return { code: "WORKTREE_EXISTS", message: stderr.trim() };
	}
	if (lower.includes("not a git repository")) {
		return { code: "NOT_A_REPO", message: stderr.trim() };
	}

	return { code: "UNKNOWN", message: stderr.trim() || "Failed to create worktree" };
}
