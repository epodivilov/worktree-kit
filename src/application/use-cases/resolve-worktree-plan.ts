import { join, relative } from "node:path";
import { CONFIG_FILENAME, LOCAL_CONFIG_FILENAME } from "../../domain/constants.ts";
import type { WorktreeConfig } from "../../domain/entities/config.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import { Notification as N, type Notification } from "../../shared/notification.ts";
import type { Result } from "../../shared/result.ts";
import { uniqueBy } from "../../shared/unique-by.ts";
import type { LoadConfigOutput } from "./load-config.ts";

export interface FileToCopy {
	src: string;
	dest: string;
	isDirectory: boolean;
}

export interface SymlinkToCreate {
	target: string;
	linkPath: string;
}

export interface ResolveWorktreePlanInput {
	repoRoot: string;
	worktreePath: string;
	config: WorktreeConfig;
	configResult: Result<LoadConfigOutput, Error> | null;
}

export interface ResolveWorktreePlanOutput {
	filesToCopy: FileToCopy[];
	symlinksToCreate: SymlinkToCreate[];
	configSymlink: SymlinkToCreate | null;
	localConfigSymlink: SymlinkToCreate | null;
	notifications: Notification[];
}

export interface ResolveWorktreePlanDeps {
	fs: FilesystemPort;
	git: GitPort;
}

function isGlobPattern(str: string): boolean {
	return /[*?[\]{}]/.test(str);
}

function splitPatterns(entries: readonly string[]): { positive: string[]; negative: string[] } {
	const positive: string[] = [];
	const negative: string[] = [];
	for (const entry of entries) {
		if (entry.startsWith("!")) {
			negative.push(entry.slice(1));
		} else {
			positive.push(entry);
		}
	}
	return { positive, negative };
}

async function resolveExclusions(
	negativePatterns: string[],
	repoRoot: string,
	fs: FilesystemPort,
): Promise<Set<string>> {
	const excluded = new Set<string>();
	for (const pattern of negativePatterns) {
		if (isGlobPattern(pattern)) {
			const matches = await fs.glob(pattern, { cwd: repoRoot });
			for (const match of matches) {
				excluded.add(match);
			}
		} else {
			excluded.add(join(repoRoot, pattern));
		}
	}
	return excluded;
}

export async function resolveWorktreePlan(
	input: ResolveWorktreePlanInput,
	deps: ResolveWorktreePlanDeps,
): Promise<ResolveWorktreePlanOutput> {
	const { repoRoot, worktreePath, config, configResult } = input;
	const { fs, git } = deps;
	const notifications: Notification[] = [];

	const { positive: copyPositive, negative: copyNegative } = splitPatterns(config.copy);
	const copyExclusions = await resolveExclusions(copyNegative, repoRoot, fs);

	const rawFiles: FileToCopy[] = [];

	for (const entry of copyPositive) {
		if (isGlobPattern(entry)) {
			const matches = await fs.glob(entry, { cwd: repoRoot });
			if (matches.length === 0) {
				notifications.push(N.warn(`No files matched pattern: ${entry}`));
				continue;
			}
			for (const matchedPath of matches) {
				const relativePath = matchedPath.slice(repoRoot.length + 1);
				if (!relativePath) {
					notifications.push(N.warn(`Pattern "${entry}" matched the repo root and was skipped.`));
					continue;
				}
				rawFiles.push({
					src: matchedPath,
					dest: join(worktreePath, relativePath),
					isDirectory: await fs.isDirectory(matchedPath),
				});
			}
		} else {
			const src = join(repoRoot, entry);
			if (!(await fs.exists(src))) {
				notifications.push(N.warn(`Copy source "${entry}" not found in repo root — skipped.`));
				continue;
			}
			rawFiles.push({
				src,
				dest: join(worktreePath, entry),
				isDirectory: await fs.isDirectory(src),
			});
		}
	}

	const filesToCopy = uniqueBy(
		rawFiles.filter((f) => !copyExclusions.has(f.src)),
		(f) => f.src,
	);

	const { positive: symlinkPositive, negative: symlinkNegative } = splitPatterns(config.symlinks);
	const symlinkExclusions = await resolveExclusions(symlinkNegative, repoRoot, fs);

	const rawSymlinks: SymlinkToCreate[] = [];

	for (const entry of symlinkPositive) {
		if (isGlobPattern(entry)) {
			const matches = await fs.glob(entry, { cwd: repoRoot });
			if (matches.length === 0) {
				notifications.push(N.warn(`No files matched symlink pattern: ${entry}`));
				continue;
			}
			for (const matchedPath of matches) {
				const relativePath = matchedPath.slice(repoRoot.length + 1);
				if (!relativePath) {
					notifications.push(N.warn(`Symlink pattern "${entry}" matched the repo root and was skipped.`));
					continue;
				}
				rawSymlinks.push({
					target: matchedPath,
					linkPath: join(worktreePath, relativePath),
				});
			}
		} else {
			const target = join(repoRoot, entry);
			if (!(await fs.exists(target))) {
				notifications.push(N.warn(`Symlink target "${entry}" not found in repo root — skipped.`));
				continue;
			}
			rawSymlinks.push({
				target,
				linkPath: join(worktreePath, entry),
			});
		}
	}

	const dedupedSymlinks = uniqueBy(
		rawSymlinks.filter((s) => !symlinkExclusions.has(s.target)),
		(s) => s.target,
	);

	const symlinksToCreate: SymlinkToCreate[] = [];
	for (const s of dedupedSymlinks) {
		const rel = relative(repoRoot, s.target);
		const trackedResult = await git.isPathTracked(repoRoot, rel);
		if (trackedResult.success && trackedResult.data) {
			notifications.push(
				N.warn(
					`Symlink target "${rel}" is tracked by git and will be skipped. Git checkout replaces symlinks with tracked content. Consider using "copy" instead.`,
				),
			);
			continue;
		}
		symlinksToCreate.push(s);
	}

	let configSymlink: SymlinkToCreate | null = null;
	let localConfigSymlink: SymlinkToCreate | null = null;

	if (configResult?.success) {
		if (!configResult.data.isLegacyConfig) {
			const trackedResult = await git.isPathTracked(repoRoot, CONFIG_FILENAME);
			if (trackedResult.success && trackedResult.data) {
				notifications.push(N.info("Config is tracked by git — already available in worktree, symlink skipped."));
			} else {
				configSymlink = {
					target: configResult.data.configPath,
					linkPath: join(worktreePath, CONFIG_FILENAME),
				};
			}
		}

		if (configResult.data.localConfigPath) {
			localConfigSymlink = {
				target: configResult.data.localConfigPath,
				linkPath: join(worktreePath, LOCAL_CONFIG_FILENAME),
			};
		}
	}

	return {
		filesToCopy,
		symlinksToCreate,
		configSymlink,
		localConfigSymlink,
		notifications,
	};
}
