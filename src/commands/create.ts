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
				required: false,
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

			let branch = args.branch as string | undefined;

			// === Interactive mode: select or create branch ===
			let isRemoteBranch = false;

			if (!branch) {
				const branchesResult = await git.listBranches();
				if (Result.isErr(branchesResult)) {
					ui.error(branchesResult.error.message);
					process.exit(1);
				}

				const remoteBranchesResult = await git.listRemoteBranches();
				if (Result.isErr(remoteBranchesResult)) {
					ui.error(remoteBranchesResult.error.message);
					process.exit(1);
				}

				const worktreesResult = await git.listWorktrees();
				if (Result.isErr(worktreesResult)) {
					ui.error(worktreesResult.error.message);
					process.exit(1);
				}

				const usedBranches = new Set(worktreesResult.data.map((w) => w.branch));
				const localBranches = new Set(branchesResult.data);
				const availableLocalBranches = branchesResult.data.filter((b) => !usedBranches.has(b));
				const availableRemoteBranches = remoteBranchesResult.data.filter(
					(b) => !localBranches.has(b) && !usedBranches.has(b),
				);

				const CREATE_NEW = "__create_new__";
				const REMOTE_BRANCHES = "__remote_branches__";

				// Build first-level options: Create new, local branches, and Remote branches submenu
				const firstLevelOptions: Array<{ value: string; label: string; hint?: string }> = [
					{ value: CREATE_NEW, label: "Create new branch", hint: "Enter a new branch name" },
					...availableLocalBranches.map((b) => ({ value: b, label: b })),
				];

				if (availableRemoteBranches.length > 0) {
					firstLevelOptions.push({
						value: REMOTE_BRANCHES,
						label: "Remote branches...",
						hint: `${availableRemoteBranches.length} available`,
					});
				}

				const selected = await ui.select<string>({
					message: "Select branch for worktree",
					options: firstLevelOptions,
				});

				if (ui.isCancel(selected)) {
					ui.cancel();
					process.exit(0);
				}

				if (selected === CREATE_NEW) {
					const newBranch = await ui.text({
						message: "Enter new branch name",
						placeholder: "feature/my-feature",
					});

					if (ui.isCancel(newBranch)) {
						ui.cancel();
						process.exit(0);
					}

					branch = newBranch;
				} else if (selected === REMOTE_BRANCHES) {
					const remoteBranch = await ui.select<string>({
						message: "Select remote branch",
						options: availableRemoteBranches.map((b) => ({ value: b, label: b })),
					});

					if (ui.isCancel(remoteBranch)) {
						ui.cancel();
						process.exit(0);
					}

					branch = remoteBranch;
					isRemoteBranch = true;
				} else {
					branch = selected;
				}
			}

			// === Stage 1: Create worktree and copy files ===
			const spinner = ui.createSpinner();
			spinner.start("Creating worktree...");

			const createResult = await createWorktree(
				{ branch, baseBranch: args.base, fromRemote: isRemoteBranch ? "origin" : undefined },
				{ git, fs },
			);

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

			ui.success(`Created worktree for branch: ${branch} at ${createResult.data.worktree.path}`);
			ui.outro("Done!");
		},
	});
}
