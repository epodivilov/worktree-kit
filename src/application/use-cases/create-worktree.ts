import { join, resolve } from "node:path";
import { INIT_ROOT_DIR } from "../../domain/constants.ts";
import type { WorktreeConfig } from "../../domain/entities/config.ts";
import type { Worktree } from "../../domain/entities/worktree.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";
import { loadConfig } from "./load-config.ts";

export interface CreateWorktreeInput {
	branch: string;
	baseBranch?: string;
}

export interface CreateWorktreeOutput {
	worktree: Worktree;
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

	const rootResult = await git.getRepositoryRoot();
	if (!rootResult.success) {
		return R.err(new Error(rootResult.error.message));
	}
	const repoRoot = rootResult.data;

	const configResult = await loadConfig({ git, fs });
	const config: WorktreeConfig = configResult.success ? configResult.data.config : { rootDir: INIT_ROOT_DIR, copy: [] };

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

	return R.ok({ worktree: createResult.data });
}
