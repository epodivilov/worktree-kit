import { join, relative, resolve } from "node:path";
import { INIT_ROOT_DIR } from "../../domain/constants.ts";
import type { WorktreeConfig } from "../../domain/entities/config.ts";
import type { Worktree } from "../../domain/entities/worktree.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import { Notification as N, type Notification } from "../../shared/notification.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";
import { uniqueBy } from "../../shared/unique-by.ts";
import { loadConfig } from "./load-config.ts";
import type { HookContext } from "./run-hooks.ts";

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

export interface CreateWorktreeInput {
	branch: string;
	baseBranch?: string;
	fromRemote?: string;
	dryRun?: boolean;
}

export interface FileToCopy {
	src: string;
	dest: string;
	isDirectory: boolean;
}

export interface SymlinkToCreate {
	target: string;
	linkPath: string;
}

export interface CreateWorktreeOutput {
	worktree: Worktree;
	notifications: Notification[];
	filesToCopy: FileToCopy[];
	symlinksToCreate: SymlinkToCreate[];
	hookContext: HookContext | null;
	hookCommands: readonly string[];
}

export interface CreateWorktreeDeps {
	git: GitPort;
	fs: FilesystemPort;
}

export async function createWorktree(
	input: CreateWorktreeInput,
	deps: CreateWorktreeDeps,
): Promise<Result<CreateWorktreeOutput, Error>> {
	const { git, fs } = deps;
	const notifications: Notification[] = [];

	const rootResult = await git.getMainWorktreeRoot();
	if (!rootResult.success) {
		return R.err(new Error(rootResult.error.message));
	}
	const repoRoot = rootResult.data;

	const configResult = await loadConfig({ git, fs });
	let config: WorktreeConfig;

	if (configResult.success) {
		config = configResult.data.config;
	} else {
		config = {
			rootDir: INIT_ROOT_DIR,
			copy: [],
			symlinks: [],
			hooks: { "post-create": [], "pre-remove": [], "post-update": [] },
			defaultBase: "ask",
			create: {},
			remove: {},
		};
		notifications.push(N.warn("Config not found, using defaults. Run 'wt init' to create one."));
	}

	const worktreePath = resolve(repoRoot, config.rootDir, input.branch);

	let worktree: Worktree;
	if (input.dryRun) {
		worktree = { path: worktreePath, branch: input.branch, head: "", isMain: false };
	} else {
		const createResult = input.fromRemote
			? await git.createWorktreeFromRemote(input.branch, worktreePath, input.fromRemote)
			: await git.createWorktree(input.branch, worktreePath, input.baseBranch);
		if (!createResult.success) {
			return R.err(new Error(createResult.error.message));
		}
		worktree = createResult.data;
	}

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
				rawFiles.push({
					src: matchedPath,
					dest: join(worktreePath, relativePath),
					isDirectory: await fs.isDirectory(matchedPath),
				});
			}
		} else {
			const src = join(repoRoot, entry);
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
				rawSymlinks.push({
					target: matchedPath,
					linkPath: join(worktreePath, relativePath),
				});
			}
		} else {
			const target = join(repoRoot, entry);
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

	const hookCommands = config.hooks["post-create"];
	const hookContext: HookContext | null =
		hookCommands.length > 0
			? {
					worktreePath,
					branch: input.branch,
					repoRoot,
					baseBranch: input.baseBranch,
				}
			: null;

	return R.ok({
		worktree,
		notifications,
		filesToCopy,
		symlinksToCreate,
		hookContext,
		hookCommands,
	});
}
