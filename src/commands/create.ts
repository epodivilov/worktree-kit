import { defineCommand } from "citty";
import pc from "picocolors";
import { createWorktree } from "../application/use-cases/create-worktree.ts";
import { loadConfig } from "../application/use-cases/load-config.ts";
import { renderNotifications } from "../cli/render-notifications.ts";
import { resolveBaseBranch, resolveBranch } from "../cli/resolve-params.ts";
import type { CreateCommandConfig, DefaultBase } from "../domain/entities/config.ts";
import type { Container } from "../infrastructure/container.ts";
import { Result } from "../shared/result.ts";

export function createCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "create",
			description: "Create a new worktree with config sync",
		},
		args: {
			branch: {
				type: "positional",
				description: "Branch name for the new worktree",
				required: false,
			},
			base: {
				type: "string",
				alias: "b",
				description: "Base branch to create from",
				required: false,
			},
			"dry-run": {
				type: "boolean",
				description: "Show what would be done without making changes",
				required: false,
			},
		},
		async run({ args }) {
			const { ui, git, fs, shell } = container;

			ui.intro("worktree-kit create");

			const dryRun = (args["dry-run"] as boolean | undefined) ?? false;

			const configResult = await loadConfig({ git, fs });
			const fallbackConfig: { defaultBase: DefaultBase; create: CreateCommandConfig } = {
				defaultBase: "ask",
				create: {},
			};
			const config = configResult.success ? configResult.data.config : fallbackConfig;
			if (!configResult.success) {
				ui.warn(configResult.error.message);
			} else if (configResult.data.isLegacyConfig) {
				ui.warn("Using legacy .worktreekitrc config. Run 'wt init --migrate' to upgrade to .worktreekit.jsonc");
			}

			// === Resolve params ===
			const { branch, isNewBranch, isRemoteBranch } = await resolveBranch(args.branch as string | undefined, {
				ui,
				git,
			});

			let baseBranch: string | undefined;
			if (isNewBranch && !isRemoteBranch) {
				baseBranch = await resolveBaseBranch(
					args.base as string | undefined,
					{ base: config.create.base, defaultBase: config.defaultBase },
					{ ui, git },
				);
			}

			// === Stage 1: Create worktree and copy files ===
			const spinner = ui.createSpinner();
			spinner.start("Creating worktree...");

			const createResult = await createWorktree(
				{ branch, baseBranch, fromRemote: isRemoteBranch ? "origin" : undefined, dryRun },
				{ git, fs },
			);

			if (Result.isErr(createResult)) {
				spinner.stop(pc.red("Failed"));
				ui.error(createResult.error.message);
				process.exit(1);
			}

			if (dryRun) {
				spinner.stop("Preview");
				const { worktree, filesToCopy, symlinksToCreate, hookCommands } = createResult.data;
				ui.info(`Would create worktree at ${worktree.path}`);
				const branchStatus = isNewBranch ? "new" : "existing";
				ui.info(`Branch: ${branch} (${branchStatus}${baseBranch ? `, from ${baseBranch}` : ""})`);
				if (filesToCopy.length > 0) {
					ui.info(`Would copy ${filesToCopy.length} file(s):`);
					for (const { dest, isDirectory } of filesToCopy) {
						const relativePath = dest.slice(worktree.path.length + 1);
						ui.info(`  ${isDirectory ? "dir" : "file"}: ${relativePath}`);
					}
				}
				if (symlinksToCreate.length > 0) {
					ui.info(`Would create ${symlinksToCreate.length} symlink(s):`);
					for (const { linkPath } of symlinksToCreate) {
						const relativePath = linkPath.slice(worktree.path.length + 1);
						ui.info(`  link: ${relativePath}`);
					}
				}
				if (hookCommands.length > 0) {
					ui.info(`Would run ${hookCommands.length} hook(s):`);
					for (const command of hookCommands) {
						ui.info(`  ${command}`);
					}
				}
				renderNotifications(ui, createResult.data.notifications);
				ui.outro("Dry run — no changes made");
				return;
			}

			// Copy files and directories with spinner updates
			const { filesToCopy, symlinksToCreate } = createResult.data;
			for (const { src, dest, isDirectory } of filesToCopy) {
				const name = src.split("/").pop();
				spinner.message(`Copying ${name}...`);
				if (isDirectory) {
					await fs.copyDirectory(src, dest);
				} else {
					await fs.copyFile(src, dest);
				}
			}

			// Create symlinks pointing to root repo
			for (const { target, linkPath } of symlinksToCreate) {
				const name = target.split("/").pop();
				spinner.message(`Linking ${name}...`);
				const symlinkResult = await fs.createSymlink(target, linkPath);
				if (!symlinkResult.success) {
					ui.warn(`Failed to create symlink: ${linkPath} -> ${target} (${symlinkResult.error.message})`);
				}
			}

			spinner.stop(pc.green("Worktree created"));
			renderNotifications(ui, createResult.data.notifications);

			// === Stage 2: Run hooks ===
			const { hookCommands, hookContext } = createResult.data;
			if (hookCommands.length > 0 && hookContext) {
				const hooksSpinner = ui.createSpinner();
				const total = hookCommands.length;
				const env: Record<string, string> = {
					WORKTREE_PATH: hookContext.worktreePath,
					WORKTREE_BRANCH: hookContext.branch,
					REPO_ROOT: hookContext.repoRoot,
				};
				if (hookContext.baseBranch) {
					env.BASE_BRANCH = hookContext.baseBranch;
				}

				for (const [i, command] of hookCommands.entries()) {
					const message = `Running hook ${i + 1}/${total}: ${command}...`;

					if (i === 0) {
						hooksSpinner.start(message);
					} else {
						hooksSpinner.message(message);
					}

					const result = await shell.execute(command, {
						cwd: hookContext.worktreePath,
						env,
					});

					if (!result.success) {
						ui.warn(`Hook failed: "${command}" - ${result.error.message}`);
					}
				}

				hooksSpinner.stop(pc.green("Hooks completed"));
			}

			ui.success(`Created worktree for branch: ${branch} at ${createResult.data.worktree.path}`);
			ui.outro("Done!");
		},
	});
}
