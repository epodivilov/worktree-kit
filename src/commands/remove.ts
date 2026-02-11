import { resolve } from "node:path";
import { defineCommand } from "citty";
import pc from "picocolors";
import { listWorktrees } from "../application/use-cases/list-worktrees.ts";
import { loadConfig } from "../application/use-cases/load-config.ts";
import { removeWorktree } from "../application/use-cases/remove-worktree.ts";
import { resolveBranchesToRemove, resolveDeleteBranch, resolveDeleteRemoteBranch } from "../cli/resolve-params.ts";
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
			"delete-remote-branch": {
				type: "boolean",
				description: "Delete the remote branch",
				required: false,
			},
			force: {
				type: "boolean",
				description: "Force delete unmerged branches",
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

			ui.intro("worktree-kit remove");

			const configResult = await loadConfig({ fs, git });
			const config = configResult.success ? configResult.data.config : null;

			// === Resolve params ===
			const branchesToRemove = await resolveBranchesToRemove(args.branch as string | undefined, { ui, git });

			const shouldDeleteBranches = await resolveDeleteBranch(
				args["delete-branch"] as boolean | undefined,
				config?.remove.deleteBranch,
				{ ui },
				{ branches: branchesToRemove },
			);

			const shouldDeleteRemoteBranches = await resolveDeleteRemoteBranch(
				args["delete-remote-branch"] as boolean | undefined,
				config?.remove.deleteRemoteBranch,
				{ ui },
				{ branches: branchesToRemove },
			);

			const force = (args.force as boolean | undefined) ?? false;
			const dryRun = (args["dry-run"] as boolean | undefined) ?? false;

			if (dryRun) {
				for (const branch of branchesToRemove) {
					ui.info(`Would remove worktree "${branch}"`);
					if (shouldDeleteBranches && shouldDeleteRemoteBranches) {
						ui.info(`Would delete branch "${branch}" (local & remote)`);
					} else if (shouldDeleteBranches) {
						ui.info(`Would delete branch "${branch}" (local)`);
					}
				}
				ui.outro("Dry run — no changes made");
				return;
			}

			// === Remove worktrees ===
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

			if (branchesToRemove.length === 1) {
				// === Single worktree — sequential with spinners ===
				const branchToRemove = branchesToRemove[0] as string;

				// Pre-remove hooks
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

				// Remove worktree
				const spinner = ui.createSpinner();
				spinner.start(`Removing worktree "${branchToRemove}"...`);
				const result = await removeWorktree({ branch: branchToRemove }, { git });

				if (Result.isErr(result)) {
					spinner.stop(pc.red(`Failed to remove "${branchToRemove}"`));
					ui.error(result.error.message);
				} else {
					spinner.stop(pc.green(`Worktree "${branchToRemove}" removed`));

					// Delete branch
					if (shouldDeleteBranches) {
						spinner.start(`Deleting branch "${branchToRemove}"...`);

						let localDeleted = false;
						const deleteResult = await git.deleteBranch(branchToRemove);

						if (Result.isErr(deleteResult)) {
							if (deleteResult.error.code === "BRANCH_NOT_MERGED") {
								spinner.stop(pc.yellow(`Branch "${branchToRemove}" not merged`));

								let shouldForce = force;
								if (!shouldForce && !ui.nonInteractive) {
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
										localDeleted = true;
									}
								} else {
									ui.info(`Branch "${branchToRemove}" was not deleted`);
								}
							} else {
								spinner.stop(pc.red(`Failed to delete branch "${branchToRemove}"`));
							}
						} else {
							localDeleted = true;
						}

						if (localDeleted && shouldDeleteRemoteBranches) {
							spinner.message(`Deleting remote branch "${branchToRemove}"...`);
							const deleteRemoteResult = await git.deleteRemoteBranch(branchToRemove);
							if (Result.isErr(deleteRemoteResult)) {
								spinner.stop(pc.green(`Branch "${branchToRemove}" deleted (local)`));
								if (deleteRemoteResult.error.code !== "REMOTE_REF_NOT_FOUND") {
									ui.warn(`Failed to delete remote branch: ${deleteRemoteResult.error.message}`);
								}
							} else {
								spinner.stop(pc.green(`Branch "${branchToRemove}" deleted (local & remote)`));
							}
						} else if (localDeleted) {
							spinner.stop(pc.green(`Branch "${branchToRemove}" deleted (local)`));
						}
					}
				}
			} else {
				// === Multiple worktrees — parallel with multi-spinner ===
				ui.info(`Removing ${branchesToRemove.length} worktrees...`);
				const ms = ui.createMultiSpinner(branchesToRemove);
				const warnings: string[] = [];

				await Promise.all(
					branchesToRemove.map(async (branchToRemove) => {
						// Pre-remove hooks
						const worktreeInfo = worktreesByBranch.get(branchToRemove);
						if (preRemoveHooks.length > 0 && worktreeInfo) {
							const env: Record<string, string> = {
								WORKTREE_PATH: worktreeInfo.path,
								WORKTREE_BRANCH: worktreeInfo.branch,
								REPO_ROOT: repoRoot,
							};
							const hookTotal = preRemoveHooks.length;
							for (const [i, command] of preRemoveHooks.entries()) {
								ms.update(branchToRemove, `executing "${command}" [${i + 1}/${hookTotal}]`);
								const hookResult = await shell.execute(command, {
									cwd: worktreeInfo.path,
									env,
								});
								if (!hookResult.success) {
									warnings.push(`Hook failed for "${branchToRemove}": ${command}`);
								}
							}
						}

						// Remove worktree
						ms.update(branchToRemove, "removing worktree");
						const result = await removeWorktree({ branch: branchToRemove }, { git });
						if (Result.isErr(result)) {
							ms.fail(branchToRemove, result.error.message);
							return;
						}

						// Delete branch
						let branchStatus = "";
						if (shouldDeleteBranches) {
							ms.update(branchToRemove, "deleting branch");
							let localDeleted = false;
							const deleteResult = await git.deleteBranch(branchToRemove);

							if (Result.isErr(deleteResult)) {
								if (deleteResult.error.code === "BRANCH_NOT_MERGED") {
									if (force) {
										const forceResult = await git.deleteBranchForce(branchToRemove);
										localDeleted = Result.isOk(forceResult);
									}
									if (!localDeleted) {
										branchStatus = " (branch not merged, use --force)";
									}
								}
							} else {
								localDeleted = true;
							}

							if (localDeleted && shouldDeleteRemoteBranches) {
								ms.update(branchToRemove, "deleting remote branch");
								const deleteRemoteResult = await git.deleteRemoteBranch(branchToRemove);
								branchStatus = Result.isOk(deleteRemoteResult)
									? " + branch deleted (local & remote)"
									: " + branch deleted (local)";
							} else if (localDeleted) {
								branchStatus = " + branch deleted (local)";
							}
						}

						ms.complete(branchToRemove, `removed${branchStatus}`);
					}),
				);

				ms.stop();

				for (const warning of warnings) {
					ui.warn(warning);
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
								const cleanupSpinner = ui.createSpinner();
								cleanupSpinner.start("Cleaning up empty worktrees directory...");
								const removeResult = await fs.removeDirectory(worktreesRootPath);
								if (Result.isOk(removeResult)) {
									cleanupSpinner.stop(pc.green("Worktrees directory removed"));
								} else {
									cleanupSpinner.stop(pc.red("Failed to remove worktrees directory"));
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
