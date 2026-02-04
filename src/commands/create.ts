import { defineCommand } from "citty";
import pc from "picocolors";
import { createWorktree } from "../application/use-cases/create-worktree.ts";
import { renderNotifications } from "../cli/render-notifications.ts";
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
				required: true,
			},
			base: {
				type: "string",
				alias: "b",
				description: "Base branch to create from",
				required: false,
			},
		},
		async run({ args }) {
			const { ui, git, fs, shell } = container;

			ui.intro("worktree-kit create");

			// === Stage 1: Create worktree and copy files ===
			const spinner = ui.createSpinner();
			spinner.start("Creating worktree...");

			const createResult = await createWorktree({ branch: args.branch, baseBranch: args.base }, { git, fs });

			if (Result.isErr(createResult)) {
				spinner.stop(pc.red("Failed"));
				ui.error(createResult.error.message);
				process.exit(1);
			}

			// Copy files with spinner updates
			const { filesToCopy } = createResult.data;
			for (const { src, dest } of filesToCopy) {
				const fileName = src.split("/").pop();
				spinner.message(`Copying ${fileName}...`);
				await fs.copyFile(src, dest);
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

			ui.success(`Created worktree for branch: ${args.branch} at ${createResult.data.worktree.path}`);
			ui.outro("Done!");
		},
	});
}
