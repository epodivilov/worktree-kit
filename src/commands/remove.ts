import { resolve } from "node:path";
import { defineCommand } from "citty";
import pc from "picocolors";
import { listWorktrees } from "../application/use-cases/list-worktrees.ts";
import { loadConfig } from "../application/use-cases/load-config.ts";
import { removeWorktree } from "../application/use-cases/remove-worktree.ts";
import { INIT_ROOT_DIR } from "../domain/constants.ts";
import type { Container } from "../infrastructure/container.ts";
import { Result } from "../shared/result.ts";

export function removeCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "remove",
			description: "Remove a worktree",
		},
		args: {
			branch: {
				type: "positional",
				description: "Branch name of the worktree to remove",
				required: false,
			},
		},
		async run({ args }) {
			const { ui, git, fs } = container;

			ui.intro("worktree-kit remove");

			const branch = args.branch as string | undefined;

			const REMOVE_ALL = "__remove_all__";
			let branchesToRemove: string[] = [];
			let shouldDeleteBranches = false;

			if (!branch) {
				const listResult = await listWorktrees({ git });

				if (Result.isErr(listResult)) {
					ui.error(listResult.error.message);
					process.exit(1);
				}

				const removable = listResult.data.worktrees.filter((w) => !w.isMain);

				if (removable.length === 0) {
					ui.info("No worktrees to remove");
					ui.outro("Done!");
					return;
				}

				const options = [
					...removable.map((w) => ({
						value: w.branch,
						label: w.branch,
						hint: w.path,
					})),
				];

				if (removable.length > 1) {
					options.push({
						value: REMOVE_ALL,
						label: "Remove all worktrees",
						hint: `${removable.length} worktrees`,
					});
				}

				const selected = await ui.select<string>({
					message: "Select worktree to remove",
					options,
				});

				if (ui.isCancel(selected)) {
					ui.cancel();
					process.exit(0);
				}

				if (selected === REMOVE_ALL) {
					ui.info("The following worktrees will be removed:");
					for (const w of removable) {
						ui.info(`  - ${w.branch} (${w.path})`);
					}

					const confirmed = await ui.confirm({
						message: `Remove all ${removable.length} worktrees?`,
						initialValue: false,
					});

					if (ui.isCancel(confirmed) || !confirmed) {
						ui.cancel();
						process.exit(0);
					}

					branchesToRemove = removable.map((w) => w.branch);
				} else {
					const confirmed = await ui.confirm({
						message: `Remove worktree "${selected}"?`,
						initialValue: false,
					});

					if (ui.isCancel(confirmed) || !confirmed) {
						ui.cancel();
						process.exit(0);
					}

					branchesToRemove = [selected];
				}
			} else {
				branchesToRemove = [branch];
			}

			const deleteBranchConfirm = await ui.confirm({
				message:
					branchesToRemove.length > 1
						? `Also delete ${branchesToRemove.length} branches?`
						: `Also delete branch "${branchesToRemove[0]}"?`,
				initialValue: false,
			});

			if (ui.isCancel(deleteBranchConfirm)) {
				ui.cancel();
				process.exit(0);
			}

			shouldDeleteBranches = deleteBranchConfirm === true;

			const spinner = ui.createSpinner();

			for (const branchToRemove of branchesToRemove) {
				spinner.start(`Removing worktree "${branchToRemove}"...`);

				const result = await removeWorktree({ branch: branchToRemove }, { git });

				if (Result.isErr(result)) {
					spinner.stop(pc.red(`Failed to remove "${branchToRemove}"`));
					ui.error(result.error.message);
					continue;
				}

				spinner.stop(pc.green(`Worktree "${branchToRemove}" removed`));

				if (shouldDeleteBranches) {
					spinner.start(`Deleting branch "${branchToRemove}"...`);

					const deleteResult = await git.deleteBranch(branchToRemove);

					if (Result.isErr(deleteResult)) {
						if (deleteResult.error.code === "BRANCH_NOT_MERGED") {
							spinner.stop(pc.yellow(`Branch "${branchToRemove}" not merged`));

							const forceConfirm = await ui.confirm({
								message: `Branch "${branchToRemove}" is not merged. Force delete?`,
								initialValue: false,
							});

							if (!ui.isCancel(forceConfirm) && forceConfirm) {
								spinner.start(`Force deleting branch "${branchToRemove}"...`);
								const forceResult = await git.deleteBranchForce(branchToRemove);

								if (Result.isErr(forceResult)) {
									spinner.stop(pc.red(`Failed to delete branch "${branchToRemove}"`));
								} else {
									spinner.stop(pc.green(`Branch "${branchToRemove}" deleted`));
								}
							} else {
								ui.info(`Branch "${branchToRemove}" was not deleted`);
							}
						} else {
							spinner.stop(pc.red(`Failed to delete branch "${branchToRemove}"`));
						}
					} else {
						spinner.stop(pc.green(`Branch "${branchToRemove}" deleted`));
					}
				}
			}

			// Check if root directory should be cleaned up
			const remainingResult = await listWorktrees({ git });
			if (Result.isOk(remainingResult)) {
				const nonMainWorktrees = remainingResult.data.worktrees.filter((w) => !w.isMain);

				if (nonMainWorktrees.length === 0) {
					// All worktrees removed, check if we should clean up root directory
					const configResult = await loadConfig({ fs, git });
					const rootDir = Result.isOk(configResult) ? configResult.data.config.rootDir : INIT_ROOT_DIR;

					const mainRoot = await git.getMainWorktreeRoot();
					if (Result.isOk(mainRoot)) {
						const worktreesRootPath = resolve(mainRoot.data, rootDir);

						if (await fs.exists(worktreesRootPath)) {
							const isEmptyResult = await fs.isDirectoryEmpty(worktreesRootPath);

							if (Result.isOk(isEmptyResult) && isEmptyResult.data) {
								const cleanupConfirm = await ui.confirm({
									message: `Remove empty worktrees directory "${worktreesRootPath}"?`,
									initialValue: true,
								});

								if (!ui.isCancel(cleanupConfirm) && cleanupConfirm) {
									const removeResult = await fs.removeDirectory(worktreesRootPath);
									if (Result.isOk(removeResult)) {
										ui.info("Worktrees directory removed");
									}
								}
							}
						}
					}
				}
			}

			ui.outro("Done!");
		},
	});
}
