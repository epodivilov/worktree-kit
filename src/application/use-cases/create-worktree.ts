import { join, resolve } from "node:path";
import { INIT_ROOT_DIR } from "../../domain/constants.ts";
import type { WorktreeConfig } from "../../domain/entities/config.ts";
import type { Worktree } from "../../domain/entities/worktree.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import { Notification as N, type Notification } from "../../shared/notification.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";
import { loadConfig } from "./load-config.ts";
import type { HookContext } from "./run-hooks.ts";

function isGlobPattern(str: string): boolean {
	return /[*?[\]{}]/.test(str);
}

export interface CreateWorktreeInput {
	branch: string;
	baseBranch?: string;
	fromRemote?: string;
}

export interface FileToCopy {
	src: string;
	dest: string;
	isDirectory: boolean;
}

export interface CreateWorktreeOutput {
	worktree: Worktree;
	notifications: Notification[];
	filesToCopy: FileToCopy[];
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

	const rootResult = await git.getRepositoryRoot();
	if (!rootResult.success) {
		return R.err(new Error(rootResult.error.message));
	}
	const repoRoot = rootResult.data;

	const configResult = await loadConfig({ git, fs });
	let config: WorktreeConfig;

	if (configResult.success) {
		config = configResult.data.config;
	} else {
		config = { rootDir: INIT_ROOT_DIR, copy: [], hooks: { "post-create": [] }, defaultBase: "ask" };
		notifications.push(N.warn("Config not found, using defaults. Run 'wt init' to create one."));
	}

	const worktreePath = resolve(repoRoot, config.rootDir, input.branch);

	const createResult = input.fromRemote
		? await git.createWorktreeFromRemote(input.branch, worktreePath, input.fromRemote)
		: await git.createWorktree(input.branch, worktreePath, input.baseBranch);
	if (!createResult.success) {
		return R.err(new Error(createResult.error.message));
	}

	const rawFiles: FileToCopy[] = [];

	for (const entry of config.copy) {
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

	const seen = new Set<string>();
	const filesToCopy = rawFiles.filter((f) => {
		if (seen.has(f.src)) return false;
		seen.add(f.src);
		return true;
	});

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
		worktree: createResult.data,
		notifications,
		filesToCopy,
		hookContext,
		hookCommands,
	});
}
