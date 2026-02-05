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

			let branch = args.branch as string | undefined;

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

				const selected = await ui.select<string>({
					message: "Select worktree to remove",
					options: removable.map((w) => ({
						value: w.branch,
						label: w.branch,
						hint: w.path,
					})),
				});

				if (ui.isCancel(selected)) {
					ui.cancel();
					process.exit(0);
				}

				const confirmed = await ui.confirm({
					message: `Remove worktree "${selected}"?`,
					initialValue: false,
				});

				if (ui.isCancel(confirmed) || !confirmed) {
					ui.cancel();
					process.exit(0);
				}

				branch = selected;
			}

			const deleteBranchConfirm = await ui.confirm({
				message: `Also delete branch "${branch}"?`,
				initialValue: false,
			});

			if (ui.isCancel(deleteBranchConfirm)) {
				ui.cancel();
				process.exit(0);
			}

			const shouldDeleteBranch = deleteBranchConfirm === true;

			const spinner = ui.createSpinner();
			spinner.start("Removing worktree...");

			const result = await removeWorktree({ branch }, { git });

			if (Result.isErr(result)) {
				spinner.stop(pc.red("Failed"));
				ui.error(result.error.message);
				process.exit(1);
			}

			spinner.stop(pc.green("Worktree removed"));

			if (shouldDeleteBranch) {
				spinner.start("Deleting branch...");

				const deleteResult = await git.deleteBranch(branch);

				if (Result.isErr(deleteResult)) {
					if (deleteResult.error.code === "BRANCH_NOT_MERGED") {
						spinner.stop(pc.yellow("Branch not merged"));

						const forceConfirm = await ui.confirm({
							message: `Branch "${branch}" is not merged. Force delete?`,
							initialValue: false,
						});

						if (!ui.isCancel(forceConfirm) && forceConfirm) {
							spinner.start("Force deleting branch...");
							const forceResult = await git.deleteBranchForce(branch);

							if (Result.isErr(forceResult)) {
								spinner.stop(pc.red("Failed to delete branch"));
							} else {
								spinner.stop(pc.green("Branch deleted"));
							}
						} else {
							ui.info("Branch was not deleted");
						}
					} else {
						spinner.stop(pc.red("Failed to delete branch"));
					}
				} else {
					spinner.stop(pc.green("Branch deleted"));
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
