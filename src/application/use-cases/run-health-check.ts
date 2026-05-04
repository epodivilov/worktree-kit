import { join, resolve } from "node:path";
import { CONFIG_FILENAME, LOCAL_CONFIG_FILENAME } from "../../domain/constants.ts";
import type { HealthIssue, HealthReport } from "../../domain/entities/health-check.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import { Result as R, type Result } from "../../shared/result.ts";
import { loadConfig } from "./load-config.ts";

export interface RunHealthCheckDeps {
	git: GitPort;
	fs: FilesystemPort;
}

function isGlobPattern(str: string): boolean {
	return /[*?[\]{}]/.test(str);
}

async function collectWorktreeSymlinkPaths(
	patterns: readonly string[],
	repoRoot: string,
	worktreePath: string,
	fs: FilesystemPort,
): Promise<string[]> {
	const paths: string[] = [];
	for (const entry of patterns) {
		if (entry.startsWith("!")) continue;
		if (isGlobPattern(entry)) {
			const matches = await fs.glob(entry, { cwd: repoRoot });
			for (const match of matches) {
				const relativePath = match.slice(repoRoot.length + 1);
				paths.push(join(worktreePath, relativePath));
			}
		} else {
			paths.push(join(worktreePath, entry));
		}
	}
	return paths;
}

function isPrefixOfAny(dirPath: string, worktreePaths: readonly string[]): boolean {
	const prefix = `${dirPath}/`;
	return worktreePaths.some((p) => p.startsWith(prefix));
}

export async function runHealthCheck(deps: RunHealthCheckDeps): Promise<Result<HealthReport, Error>> {
	const { git, fs } = deps;
	const issues: HealthIssue[] = [];

	const mainRootResult = await git.getMainWorktreeRoot();
	if (!mainRootResult.success) {
		return R.err(new Error(mainRootResult.error.message));
	}
	const repoRoot = mainRootResult.data;

	const worktreesResult = await git.listWorktrees();
	if (!worktreesResult.success) {
		return R.err(new Error(worktreesResult.error.message));
	}
	const worktrees = worktreesResult.data;

	const configResult = await loadConfig({ fs, git });
	const config = configResult.success ? configResult.data.config : null;

	if (config) {
		const rootDirPath = resolve(repoRoot, config.rootDir);
		if (await fs.isDirectory(rootDirPath)) {
			const registered = new Set(worktrees.map((w) => w.path));
			const worktreePaths = worktrees.map((w) => w.path);
			const entries = await fs.listDirectory(rootDirPath);
			for (const entry of entries) {
				if (!(await fs.isDirectory(entry))) continue;
				if (registered.has(entry)) continue;
				if (isPrefixOfAny(entry, worktreePaths)) continue;
				issues.push({ type: "empty-prefix-directory", severity: "warning", path: entry });
			}
		}
	}

	for (const wt of worktrees) {
		if (wt.isMain) continue;
		if (!(await fs.isDirectory(wt.path))) {
			issues.push({
				type: "missing-worktree-directory",
				severity: "error",
				worktreePath: wt.path,
				branch: wt.branch,
			});
		}
	}

	if (config) {
		for (const wt of worktrees) {
			if (wt.isMain) continue;
			if (!(await fs.isDirectory(wt.path))) continue;

			const candidates = await collectWorktreeSymlinkPaths(config.symlinks, repoRoot, wt.path, fs);
			candidates.push(join(wt.path, CONFIG_FILENAME));
			candidates.push(join(wt.path, LOCAL_CONFIG_FILENAME));

			const seen = new Set<string>();
			for (const path of candidates) {
				if (seen.has(path)) continue;
				seen.add(path);
				if (await fs.isSymlinkBroken(path)) {
					issues.push({ type: "broken-symlink", severity: "error", path, worktreePath: wt.path });
				}
			}
		}
	}

	for (const wt of worktrees) {
		if (await git.isRebaseInProgress(wt.path)) {
			issues.push({
				type: "rebase-in-progress",
				severity: "error",
				worktreePath: wt.path,
				branch: wt.branch,
			});
		}
		if (await git.isMergeInProgress(wt.path)) {
			issues.push({
				type: "merge-in-progress",
				severity: "error",
				worktreePath: wt.path,
				branch: wt.branch,
			});
		}
	}

	for (const wt of worktrees) {
		const dirtyResult = await git.isDirty(wt.path);
		if (dirtyResult.success && dirtyResult.data) {
			issues.push({
				type: "dirty-worktree",
				severity: "info",
				worktreePath: wt.path,
				branch: wt.branch,
			});
		}
	}

	if (config) {
		const checkRefs = async (entries: readonly string[], field: "copy" | "symlinks") => {
			for (const entry of entries) {
				if (entry.startsWith("!") || isGlobPattern(entry)) continue;
				const fullPath = resolve(repoRoot, entry);
				if (!(await fs.exists(fullPath))) {
					issues.push({ type: "config-ref-missing", severity: "error", path: entry, field });
				}
			}
		};
		await checkRefs(config.copy, "copy");
		await checkRefs(config.symlinks, "symlinks");
	}

	const healthy = !issues.some((i) => i.severity === "error" || i.severity === "warning");
	return R.ok({ issues, healthy });
}
