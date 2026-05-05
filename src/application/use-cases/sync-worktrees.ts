import type { WorktreeConfig } from "../../domain/entities/config.ts";
import type { Worktree } from "../../domain/entities/worktree.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { ShellPort } from "../../domain/ports/shell-port.ts";
import { Notification as N, type Notification } from "../../shared/notification.ts";
import { Result as R, type Result } from "../../shared/result.ts";
import type { LoadConfigOutput } from "./load-config.ts";
import { resolveWorktreePlan, type SymlinkToCreate } from "./resolve-worktree-plan.ts";
import { runHooks } from "./run-hooks.ts";

export interface SyncWorktreesInput {
	branch?: string;
	dryRun: boolean;
	force: boolean;
	postSyncHooks: readonly string[];
	repoRoot: string;
	config: WorktreeConfig;
	configResult: Result<LoadConfigOutput, Error> | null;
}

export interface SyncReport {
	branch: string;
	path: string;
	addedSymlinks: string[];
	recreatedSymlinks: string[];
	copiedFiles: string[];
	skippedFiles: string[];
	overwrittenFiles: string[];
	hookNotifications: Notification[];
	notifications: Notification[];
}

export interface SyncWorktreesOutput {
	reports: SyncReport[];
}

export interface SyncWorktreesDeps {
	git: GitPort;
	fs: FilesystemPort;
	shell?: ShellPort;
}

async function applySymlinks(
	symlinks: readonly SymlinkToCreate[],
	dryRun: boolean,
	fs: FilesystemPort,
	report: SyncReport,
): Promise<void> {
	for (const link of symlinks) {
		const isSymlink = await fs.isSymlink(link.linkPath);
		if (isSymlink) {
			const broken = await fs.isSymlinkBroken(link.linkPath);
			if (!broken) continue;

			if (dryRun) {
				report.recreatedSymlinks.push(link.linkPath);
				continue;
			}

			const removeResult = await fs.removeSymlink(link.linkPath);
			if (!removeResult.success) {
				report.notifications.push(
					N.warn(`Failed to remove broken symlink ${link.linkPath}: ${removeResult.error.message}`),
				);
				continue;
			}
			const createResult = await fs.createSymlink(link.target, link.linkPath);
			if (!createResult.success) {
				report.notifications.push(N.warn(`Failed to recreate symlink ${link.linkPath}: ${createResult.error.message}`));
				continue;
			}
			report.recreatedSymlinks.push(link.linkPath);
			continue;
		}

		const exists = await fs.exists(link.linkPath);
		if (exists) {
			report.notifications.push(
				N.warn(`${link.linkPath} exists but is not a symlink — skipped. Remove it manually to let sync recreate it.`),
			);
			continue;
		}

		if (dryRun) {
			report.addedSymlinks.push(link.linkPath);
			continue;
		}

		const createResult = await fs.createSymlink(link.target, link.linkPath);
		if (!createResult.success) {
			report.notifications.push(N.warn(`Failed to create symlink ${link.linkPath}: ${createResult.error.message}`));
			continue;
		}
		report.addedSymlinks.push(link.linkPath);
	}
}

async function applyFiles(
	files: readonly { src: string; dest: string; isDirectory: boolean }[],
	force: boolean,
	dryRun: boolean,
	fs: FilesystemPort,
	report: SyncReport,
): Promise<void> {
	for (const file of files) {
		const exists = await fs.exists(file.dest);
		if (exists && !force) {
			report.skippedFiles.push(file.dest);
			continue;
		}

		if (dryRun) {
			if (exists) {
				report.overwrittenFiles.push(file.dest);
			} else {
				report.copiedFiles.push(file.dest);
			}
			continue;
		}

		const copyResult = file.isDirectory
			? await fs.copyDirectory(file.src, file.dest)
			: await fs.copyFile(file.src, file.dest);
		if (!copyResult.success) {
			report.notifications.push(N.warn(`Failed to copy ${file.src}: ${copyResult.error.message}`));
			continue;
		}

		if (exists) {
			report.overwrittenFiles.push(file.dest);
		} else {
			report.copiedFiles.push(file.dest);
		}
	}
}

export async function syncWorktrees(
	input: SyncWorktreesInput,
	deps: SyncWorktreesDeps,
): Promise<Result<SyncWorktreesOutput, Error>> {
	const { git, fs } = deps;

	const listResult = await git.listWorktrees();
	if (!listResult.success) {
		return R.err(new Error(listResult.error.message));
	}

	const worktrees: Worktree[] = listResult.data.filter((w) => !w.isMain && w.branch);

	if (input.branch && !worktrees.some((w) => w.branch === input.branch)) {
		return R.err(new Error(`Branch "${input.branch}" not found in worktrees`));
	}

	const targets = input.branch ? worktrees.filter((w) => w.branch === input.branch) : worktrees;

	const reports: SyncReport[] = [];

	for (const wt of targets) {
		const report: SyncReport = {
			branch: wt.branch,
			path: wt.path,
			addedSymlinks: [],
			recreatedSymlinks: [],
			copiedFiles: [],
			skippedFiles: [],
			overwrittenFiles: [],
			hookNotifications: [],
			notifications: [],
		};

		const plan = await resolveWorktreePlan(
			{
				repoRoot: input.repoRoot,
				worktreePath: wt.path,
				config: input.config,
				configResult: input.configResult,
			},
			{ fs, git },
		);

		report.notifications.push(...plan.notifications);

		const allSymlinks: SymlinkToCreate[] = [...plan.symlinksToCreate];
		if (plan.configSymlink) allSymlinks.push(plan.configSymlink);
		if (plan.localConfigSymlink) allSymlinks.push(plan.localConfigSymlink);

		await applySymlinks(allSymlinks, input.dryRun, fs, report);
		await applyFiles(plan.filesToCopy, input.force, input.dryRun, fs, report);

		if (!input.dryRun && input.postSyncHooks.length > 0 && deps.shell) {
			const hookResult = await runHooks(
				{
					commands: input.postSyncHooks,
					context: {
						worktreePath: wt.path,
						branch: wt.branch,
						repoRoot: input.repoRoot,
					},
				},
				{ shell: deps.shell },
			);
			if (hookResult.success) {
				report.hookNotifications = hookResult.data.notifications;
			} else {
				report.notifications.push(N.warn(`Failed to run post-sync hooks: ${hookResult.error.message}`));
			}
		}

		reports.push(report);
	}

	return R.ok({ reports });
}
