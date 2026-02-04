import { join, resolve } from "node:path";
import { INIT_ROOT_DIR } from "../../domain/constants.ts";
import type { WorktreeConfig } from "../../domain/entities/config.ts";
import type { Worktree } from "../../domain/entities/worktree.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { ShellPort } from "../../domain/ports/shell-port.ts";
import { Notification as N, type Notification } from "../../shared/notification.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";
import { loadConfig } from "./load-config.ts";
import { runHooks } from "./run-hooks.ts";

export interface CreateWorktreeInput {
	branch: string;
	baseBranch?: string;
}

export interface CreateWorktreeOutput {
	worktree: Worktree;
	notifications: Notification[];
}

export interface CreateWorktreeDeps {
	git: GitPort;
	fs: FilesystemPort;
	shell: ShellPort;
}

export async function createWorktree(
	input: CreateWorktreeInput,
	deps: CreateWorktreeDeps,
): Promise<Result<CreateWorktreeOutput, Error>> {
	const { git, fs, shell } = deps;
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
		config = { rootDir: INIT_ROOT_DIR, copy: [], hooks: { "post-create": [] } };
		notifications.push(N.warn("Config not found, using defaults. Run 'wt init' to create one."));
	}

	const worktreePath = resolve(repoRoot, config.rootDir, input.branch);

	const createResult = await git.createWorktree(input.branch, worktreePath);
	if (!createResult.success) {
		return R.err(new Error(createResult.error.message));
	}

	for (const file of config.copy) {
		const src = join(repoRoot, file);
		const dest = join(worktreePath, file);
		await fs.copyFile(src, dest);
	}

	if (config.hooks["post-create"].length > 0) {
		const hooksResult = await runHooks(
			{
				commands: config.hooks["post-create"],
				context: {
					worktreePath,
					branch: input.branch,
					repoRoot,
					baseBranch: input.baseBranch,
				},
			},
			{ shell },
		);

		if (hooksResult.success) {
			notifications.push(...hooksResult.data.notifications);
		}
	}

	return R.ok({ worktree: createResult.data, notifications });
}
