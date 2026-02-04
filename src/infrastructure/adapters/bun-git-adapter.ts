import { dirname } from "node:path";
import type { Worktree } from "../../domain/entities/worktree.ts";
import type { GitError, GitPort } from "../../domain/ports/git-port.ts";
import type { LoggerPort } from "../../domain/ports/logger-port.ts";
import { Result } from "../../shared/result.ts";

export function createBunGitAdapter(logger: LoggerPort): GitPort {
	async function runGit(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const command = `git ${args.join(" ")}`;
		logger.debug("git", command);

		const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		logger.debug("git", `-> exit ${exitCode}${stderr.trim() ? ` (${stderr.trim()})` : ""}`);

		return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
	}

	return {
		async isGitRepository(): Promise<Result<boolean, GitError>> {
			try {
				const { exitCode } = await runGit(["rev-parse", "--is-inside-work-tree"]);
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
				const { exitCode, stdout } = await runGit(["rev-parse", "--show-toplevel"]);
				if (exitCode !== 0) {
					return Result.err({
						code: "NOT_A_REPO",
						message: "Not inside a git repository",
					});
				}
				return Result.ok(stdout);
			} catch {
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to get repository root",
				});
			}
		},

		async getMainWorktreeRoot(): Promise<Result<string, GitError>> {
			try {
				const { exitCode, stdout: gitCommonDir } = await runGit(["rev-parse", "--git-common-dir"]);
				if (exitCode !== 0) {
					return Result.err({
						code: "NOT_A_REPO",
						message: "Not inside a git repository",
					});
				}

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
				const { exitCode, stdout } = await runGit(["worktree", "list", "--porcelain"]);
				if (exitCode !== 0) {
					return Result.err({
						code: "NOT_A_REPO",
						message: "Not inside a git repository",
					});
				}
				return Result.ok(parseWorktreesPorcelain(stdout));
			} catch {
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to list worktrees",
				});
			}
		},

		async listBranches(): Promise<Result<string[], GitError>> {
			try {
				const { exitCode, stdout } = await runGit(["branch", "--list", "--format=%(refname:short)"]);
				if (exitCode !== 0) {
					return Result.err({
						code: "NOT_A_REPO",
						message: "Not inside a git repository",
					});
				}
				const branches = stdout.split("\n").filter(Boolean);
				return Result.ok(branches);
			} catch {
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to list branches",
				});
			}
		},

		async branchExists(branch: string): Promise<Result<boolean, GitError>> {
			try {
				const { exitCode } = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
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

				const args = existsResult.data ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path];

				const { exitCode, stderr } = await runGit(args);
				if (exitCode !== 0) {
					return Result.err(mapCreateError(stderr));
				}

				const headResult = await runGit(["-C", path, "rev-parse", "HEAD"]);
				const head = headResult.stdout;

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
				const { exitCode, stderr } = await runGit(["worktree", "remove", path]);
				if (exitCode !== 0) {
					return Result.err({
						code: stderr.toLowerCase().includes("not a git repository") ? "NOT_A_REPO" : "UNKNOWN",
						message: stderr || "Failed to remove worktree",
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

		async deleteBranch(branch: string): Promise<Result<void, GitError>> {
			try {
				const { exitCode, stderr } = await runGit(["branch", "-d", branch]);
				if (exitCode !== 0) {
					const lower = stderr.toLowerCase();
					if (lower.includes("not fully merged")) {
						return Result.err({
							code: "BRANCH_NOT_MERGED",
							message: `Branch "${branch}" is not fully merged`,
						});
					}
					if (lower.includes("not found")) {
						return Result.err({
							code: "BRANCH_NOT_FOUND",
							message: `Branch "${branch}" not found`,
						});
					}
					return Result.err({
						code: "UNKNOWN",
						message: stderr || `Failed to delete branch "${branch}"`,
					});
				}
				return Result.ok(undefined);
			} catch {
				return Result.err({
					code: "UNKNOWN",
					message: `Failed to delete branch "${branch}"`,
				});
			}
		},

		async deleteBranchForce(branch: string): Promise<Result<void, GitError>> {
			try {
				const { exitCode, stderr } = await runGit(["branch", "-D", branch]);
				if (exitCode !== 0) {
					if (stderr.toLowerCase().includes("not found")) {
						return Result.err({
							code: "BRANCH_NOT_FOUND",
							message: `Branch "${branch}" not found`,
						});
					}
					return Result.err({
						code: "UNKNOWN",
						message: stderr || `Failed to delete branch "${branch}"`,
					});
				}
				return Result.ok(undefined);
			} catch {
				return Result.err({
					code: "UNKNOWN",
					message: `Failed to delete branch "${branch}"`,
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
		return { code: "BRANCH_EXISTS", message: stderr };
	}
	if (lower.includes("already exists")) {
		return { code: "WORKTREE_EXISTS", message: stderr };
	}
	if (lower.includes("not a git repository")) {
		return { code: "NOT_A_REPO", message: stderr };
	}

	return { code: "UNKNOWN", message: stderr || "Failed to create worktree" };
}
