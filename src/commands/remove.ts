import { resolve } from "node:path";
import { defineCommand } from "citty";
import pc from "picocolors";
import { listWorktrees } from "../application/use-cases/list-worktrees.ts";
import { loadConfig } from "../application/use-cases/load-config.ts";
import { removeWorktree } from "../application/use-cases/remove-worktree.ts";
import { parseBooleanFlag, resolveBranchesToRemove, resolveDeleteBranch } from "../cli/resolve-params.ts";
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
			"delete-branch": {
				type: "boolean",
				description: "Delete the branch after removing worktree",
				required: false,
			},
			"no-delete-branch": {
				type: "boolean",
				description: "Do not delete the branch",
				required: false,
			},
			force: {
				type: "boolean",
				description: "Force delete unmerged branches",
				required: false,
			},
		},
		async run({ args }) {
			const { ui, git, fs, shell } = container;

			ui.intro("worktree-kit remove");

			const configResult = await loadConfig({ fs, git });
			const config = configResult.success ? configResult.data.config : null;

			// === Resolve params ===
			const branchesToRemove = await resolveBranchesToRemove(args.branch as string | undefined, { ui, git });

			const deleteBranchFlag = parseBooleanFlag(
				args["delete-branch"] as boolean | undefined,
				args["no-delete-branch"] as boolean | undefined,
			);
			const shouldDeleteBranches = await resolveDeleteBranch(
				deleteBranchFlag,
				config?.remove.deleteBranch,
				{ ui },
				{ branches: branchesToRemove },
			);

			const force = (args.force as boolean | undefined) ?? false;

			// === Remove worktrees ===
			const spinner = ui.createSpinner();

			const preRemoveHooks = config?.hooks["pre-remove"] ?? [];

			const worktreesByBranch = new Map<string, { path: string; branch: string }>();
			let repoRoot = "";

			if (preRemoveHooks.length > 0) {
				const worktreeListResult = await git.listWorktrees();
				if (Result.isOk(worktreeListResult)) {
					for (const w of worktreeListResult.data) {
						worktreesByBranch.set(w.branch, { path: w.path, branch: w.branch });
					}
				}

				const rootResult = await git.getRepositoryRoot();
				if (Result.isOk(rootResult)) {
					repoRoot = rootResult.data;
				}
			}

			for (const branchToRemove of branchesToRemove) {
				// Run pre-remove hooks
				const worktreeInfo = worktreesByBranch.get(branchToRemove);
				if (preRemoveHooks.length > 0 && worktreeInfo) {
					const hooksSpinner = ui.createSpinner();
					const total = preRemoveHooks.length;
					const env: Record<string, string> = {
						WORKTREE_PATH: worktreeInfo.path,
						WORKTREE_BRANCH: worktreeInfo.branch,
						REPO_ROOT: repoRoot,
					};

					for (const [i, command] of preRemoveHooks.entries()) {
						const message = `Running pre-remove hook ${i + 1}/${total}: ${command}...`;

						if (i === 0) {
							hooksSpinner.start(message);
						} else {
							hooksSpinner.message(message);
						}

						const hookResult = await shell.execute(command, {
							cwd: worktreeInfo.path,
							env,
						});

						if (!hookResult.success) {
							ui.warn(`Pre-remove hook failed: "${command}" - ${hookResult.error.message}`);
						}
					}

					hooksSpinner.stop(pc.green("Pre-remove hooks completed"));
				}

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

							let shouldForce = force;
							if (!shouldForce) {
								const forceConfirm = await ui.confirm({
									message: `Branch "${branchToRemove}" is not merged. Force delete?`,
									initialValue: false,
								});
								shouldForce = !ui.isCancel(forceConfirm) && forceConfirm;
							}

							if (shouldForce) {
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
					const cleanupConfigResult = await loadConfig({ fs, git });
					const rootDir = Result.isOk(cleanupConfigResult) ? cleanupConfigResult.data.config.rootDir : INIT_ROOT_DIR;

					const mainRoot = await git.getMainWorktreeRoot();
					if (Result.isOk(mainRoot)) {
						const worktreesRootPath = resolve(mainRoot.data, rootDir);

						if (await fs.exists(worktreesRootPath)) {
							const isEmptyResult = await fs.isDirectoryEmpty(worktreesRootPath);

							if (Result.isOk(isEmptyResult) && isEmptyResult.data) {
								const removeResult = await fs.removeDirectory(worktreesRootPath);
								if (Result.isOk(removeResult)) {
									ui.info("Worktrees directory removed");
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
