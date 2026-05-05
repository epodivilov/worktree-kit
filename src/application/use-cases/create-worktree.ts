import { resolve } from "node:path";
import { INIT_ROOT_DIR } from "../../domain/constants.ts";
import type { WorktreeConfig } from "../../domain/entities/config.ts";
import type { Worktree } from "../../domain/entities/worktree.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import { Notification as N, type Notification } from "../../shared/notification.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";
import { loadConfig } from "./load-config.ts";
import { type FileToCopy, resolveWorktreePlan, type SymlinkToCreate } from "./resolve-worktree-plan.ts";
import type { HookContext } from "./run-hooks.ts";

export type { FileToCopy, SymlinkToCreate };

export interface CreateWorktreeInput {
	branch: string;
	baseBranch?: string;
	fromRemote?: string;
	dryRun?: boolean;
}

export interface CreateWorktreeOutput {
	worktree: Worktree;
	notifications: Notification[];
	configSymlink: SymlinkToCreate | null;
	localConfigSymlink: SymlinkToCreate | null;
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
		if (configResult.data.isLegacyConfig) {
			notifications.push(
				N.warn("Legacy config detected. Run 'wt init --migrate' to enable config symlink in worktrees."),
			);
		}
	} else {
		config = {
			rootDir: INIT_ROOT_DIR,
			copy: [],
			symlinks: [],
			hooks: { "post-create": [], "pre-remove": [], "post-update": [], "on-conflict": [], "post-sync": [] },
			defaultBase: "ask",
			create: {},
			remove: {},
		};
		notifications.push(N.warn("Config not found, using defaults. Run 'wt init' to create one."));
	}

	const worktreePath = resolve(repoRoot, config.rootDir, input.branch);

	let worktree: Worktree;
	if (input.dryRun) {
		worktree = { path: worktreePath, branch: input.branch, head: "", isMain: false, isPrunable: false };
	} else {
		const createResult = input.fromRemote
			? await git.createWorktreeFromRemote(input.branch, worktreePath, input.fromRemote)
			: await git.createWorktree(input.branch, worktreePath, input.baseBranch);
		if (!createResult.success) {
			return R.err(new Error(createResult.error.message));
		}
		worktree = createResult.data;
	}

	const plan = await resolveWorktreePlan({ repoRoot, worktreePath, config, configResult }, { fs, git });

	notifications.push(...plan.notifications);

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
		configSymlink: plan.configSymlink,
		localConfigSymlink: plan.localConfigSymlink,
		filesToCopy: plan.filesToCopy,
		symlinksToCreate: plan.symlinksToCreate,
		hookContext,
		hookCommands,
	});
}
