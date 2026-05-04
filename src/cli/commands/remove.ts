import { resolve } from "node:path";
import { defineCommand } from "citty";
import pc from "picocolors";
import * as v from "valibot";
import { listWorktrees } from "../../application/use-cases/list-worktrees.ts";
import { loadConfig } from "../../application/use-cases/load-config.ts";
import { removeWorktree } from "../../application/use-cases/remove-worktree.ts";
import { INIT_ROOT_DIR } from "../../domain/constants.ts";
import { RemoveArgsSchema } from "../../domain/schemas/command-args-schema.ts";
import type { Container } from "../../infrastructure/container.ts";
import { Result } from "../../shared/result.ts";
import { resolveDeleteBranch, resolveDeleteRemoteBranch, resolveWorktreesToRemove } from "../resolve-params.ts";
import { runCommand } from "../run-command.ts";

export function removeCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "remove",
			description: "Remove a worktree (cleans up orphaned worktrees too)",
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

			await runCommand(async () => {
				const parsed = v.parse(RemoveArgsSchema, args);
				const { force } = parsed;
				const dryRun = parsed["dry-run"];

				const configResult = await loadConfig({ fs, git });
				const config = configResult.success ? configResult.data.config : null;
				if (!configResult.success) {
					ui.warn(configResult.error.message);
				} else if (configResult.data.isLegacyConfig) {
					ui.warn("Using legacy .worktreekitrc config. Run 'wt init --migrate' to upgrade to .worktreekit.jsonc");
				}

				// === Resolve params ===
				const worktreesToRemove = await resolveWorktreesToRemove(parsed.branch, { ui, git });

				const branchCapableEntries = worktreesToRemove.filter((w) => w.branch.length > 0);
				const branchCapableNames = branchCapableEntries.map((w) => w.branch);

				const shouldDeleteBranches =
					branchCapableEntries.length > 0
						? await resolveDeleteBranch(
								parsed["delete-branch"],
								config?.remove.deleteBranch,
								{ ui },
								{
									branches: branchCapableNames,
								},
							)
						: false;

				const shouldDeleteRemoteBranches =
					branchCapableEntries.length > 0
						? await resolveDeleteRemoteBranch(
								parsed["delete-remote-branch"],
								config?.remove.deleteRemoteBranch,
								{ ui },
								{ branches: branchCapableNames },
							)
						: false;

				if (dryRun) {
					for (const wt of worktreesToRemove) {
						const label = wt.branch || `<detached> (${wt.path})`;
						if (wt.isPrunable) {
							ui.info(`Would prune orphaned worktree "${wt.path}"`);
						} else {
							ui.info(`Would remove worktree "${label}"`);
						}
						if (wt.branch && shouldDeleteBranches && shouldDeleteRemoteBranches) {
							ui.info(`Would delete branch "${wt.branch}" (local & remote)`);
						} else if (wt.branch && shouldDeleteBranches) {
							ui.info(`Would delete branch "${wt.branch}" (local)`);
						}
					}
					ui.outro("Dry run — no changes made");
					return;
				}

				// === Remove worktrees ===
				const preRemoveHooks = config?.hooks["pre-remove"] ?? [];

				let repoRoot = "";
				if (preRemoveHooks.length > 0) {
					const rootResult = await git.getRepositoryRoot();
					if (Result.isOk(rootResult)) {
						repoRoot = rootResult.data;
					}
				}

				if (worktreesToRemove.length === 1) {
					// === Single worktree — sequential with spinners ===
					const wt = worktreesToRemove[0] as (typeof worktreesToRemove)[number];
					const displayLabel = wt.branch || `<detached> (${wt.path})`;

					// Pre-remove hooks (skip for orphans — directory is gone)
					if (preRemoveHooks.length > 0 && !wt.isPrunable) {
						const hooksSpinner = ui.createSpinner();
						const total = preRemoveHooks.length;
						const env: Record<string, string> = {
							WORKTREE_PATH: wt.path,
							WORKTREE_BRANCH: wt.branch,
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
								cwd: wt.path,
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
					const startMessage = wt.isPrunable
						? `Pruning orphaned worktree "${wt.path}"...`
						: `Removing worktree "${displayLabel}"...`;
					spinner.start(startMessage);
					const result = await removeWorktree({ worktree: wt, force }, { git });

					if (Result.isErr(result)) {
						spinner.stop(pc.red(`Failed to remove "${displayLabel}"`));
						ui.error(result.error.message);
					} else {
						const doneMessage = wt.isPrunable
							? `Orphaned worktree "${wt.path}" pruned`
							: `Worktree "${displayLabel}" removed`;
						spinner.stop(pc.green(doneMessage));

						// Delete branch — only if there is a branch
						if (shouldDeleteBranches && wt.branch) {
							spinner.start(`Deleting branch "${wt.branch}"...`);

							let localDeleted = false;
							const deleteResult = await git.deleteBranch(wt.branch);

							if (Result.isErr(deleteResult)) {
								if (deleteResult.error.code === "BRANCH_NOT_MERGED") {
									spinner.stop(pc.yellow(`Branch "${wt.branch}" not merged`));

									let shouldForce = force;
									if (!shouldForce && !ui.nonInteractive) {
										const forceConfirm = await ui.confirm({
											message: `Branch "${wt.branch}" is not merged. Force delete?`,
											initialValue: false,
										});
										shouldForce = !ui.isCancel(forceConfirm) && forceConfirm;
									}

									if (shouldForce) {
										spinner.start(`Force deleting branch "${wt.branch}"...`);
										const forceResult = await git.deleteBranchForce(wt.branch);
										if (Result.isErr(forceResult)) {
											spinner.stop(pc.red(`Failed to delete branch "${wt.branch}"`));
										} else {
											localDeleted = true;
										}
									} else {
										ui.info(`Branch "${wt.branch}" was not deleted`);
									}
								} else {
									spinner.stop(pc.red(`Failed to delete branch "${wt.branch}"`));
								}
							} else {
								localDeleted = true;
							}

							if (localDeleted && shouldDeleteRemoteBranches) {
								spinner.message(`Deleting remote branch "${wt.branch}"...`);
								const deleteRemoteResult = await git.deleteRemoteBranch(wt.branch);
								if (Result.isErr(deleteRemoteResult)) {
									spinner.stop(pc.green(`Branch "${wt.branch}" deleted (local)`));
									if (deleteRemoteResult.error.code !== "REMOTE_REF_NOT_FOUND") {
										ui.warn(`Failed to delete remote branch: ${deleteRemoteResult.error.message}`);
									}
								} else {
									spinner.stop(pc.green(`Branch "${wt.branch}" deleted (local & remote)`));
								}
							} else if (localDeleted) {
								spinner.stop(pc.green(`Branch "${wt.branch}" deleted (local)`));
							}
						}
					}
				} else {
					// === Multiple worktrees — parallel with multi-spinner ===
					ui.info(`Removing ${worktreesToRemove.length} worktrees...`);
					const keys = worktreesToRemove.map((w) => w.path);
					const ms = ui.createMultiSpinner(keys);
					const warnings: string[] = [];
					const unmergedBranches: string[] = [];

					await Promise.all(
						worktreesToRemove.map(async (wt) => {
							const displayLabel = wt.branch || `<detached> (${wt.path})`;

							// Pre-remove hooks (skip for orphans)
							if (preRemoveHooks.length > 0 && !wt.isPrunable) {
								const env: Record<string, string> = {
									WORKTREE_PATH: wt.path,
									WORKTREE_BRANCH: wt.branch,
									REPO_ROOT: repoRoot,
								};
								const hookTotal = preRemoveHooks.length;
								for (const [i, command] of preRemoveHooks.entries()) {
									ms.update(wt.path, `executing "${command}" [${i + 1}/${hookTotal}]`);
									const hookResult = await shell.execute(command, {
										cwd: wt.path,
										env,
									});
									if (!hookResult.success) {
										warnings.push(`Hook failed for "${displayLabel}": ${command}`);
									}
								}
							}

							// Remove worktree
							ms.update(wt.path, wt.isPrunable ? "pruning orphaned worktree" : "removing worktree");
							const result = await removeWorktree({ worktree: wt, force }, { git });
							if (Result.isErr(result)) {
								ms.fail(wt.path, result.error.message);
								return;
							}

							// Delete branch — only if there is a branch
							let branchStatus = "";
							if (shouldDeleteBranches && wt.branch) {
								ms.update(wt.path, "deleting branch");
								let localDeleted = false;
								const deleteResult = await git.deleteBranch(wt.branch);

								if (Result.isErr(deleteResult)) {
									if (deleteResult.error.code === "BRANCH_NOT_MERGED") {
										if (force) {
											const forceResult = await git.deleteBranchForce(wt.branch);
											localDeleted = Result.isOk(forceResult);
										}
										if (!localDeleted) {
											unmergedBranches.push(wt.branch);
											branchStatus = " (branch kept — not fully merged)";
										}
									}
								} else {
									localDeleted = true;
								}

								if (localDeleted && shouldDeleteRemoteBranches) {
									ms.update(wt.path, "deleting remote branch");
									const deleteRemoteResult = await git.deleteRemoteBranch(wt.branch);
									branchStatus = Result.isOk(deleteRemoteResult)
										? " + branch deleted (local & remote)"
										: " + branch deleted (local)";
								} else if (localDeleted) {
									branchStatus = " + branch deleted (local)";
								}
							}

							const verb = wt.isPrunable ? "pruned" : "removed";
							ms.complete(wt.path, `${verb}${branchStatus}`);
						}),
					);

					ms.stop();

					for (const warning of warnings) {
						ui.warn(warning);
					}

					// Prompt to force-delete unmerged branches
					if (unmergedBranches.length > 0 && !ui.nonInteractive) {
						const confirmMessage =
							unmergedBranches.length === 1
								? `Branch "${unmergedBranches[0]}" is not fully merged. Force delete?`
								: `${unmergedBranches.length} branches are not fully merged (${unmergedBranches.join(", ")}). Force delete?`;

						const forceConfirm = await ui.confirm({
							message: confirmMessage,
							initialValue: false,
						});

						if (!ui.isCancel(forceConfirm) && forceConfirm) {
							for (const branch of unmergedBranches) {
								const spinner = ui.createSpinner();
								spinner.start(`Force deleting branch "${branch}"...`);
								const forceResult = await git.deleteBranchForce(branch);
								if (Result.isOk(forceResult)) {
									if (shouldDeleteRemoteBranches) {
										spinner.message(`Deleting remote branch "${branch}"...`);
										const remoteResult = await git.deleteRemoteBranch(branch);
										spinner.stop(
											Result.isOk(remoteResult)
												? pc.green(`Branch "${branch}" deleted (local & remote)`)
												: pc.green(`Branch "${branch}" deleted (local)`),
										);
									} else {
										spinner.stop(pc.green(`Branch "${branch}" deleted (local)`));
									}
								} else {
									spinner.stop(pc.red(`Failed to delete branch "${branch}"`));
								}
							}
						} else {
							for (const branch of unmergedBranches) {
								ui.info(`Branch "${branch}" was not deleted`);
							}
						}
					} else if (unmergedBranches.length > 0) {
						for (const branch of unmergedBranches) {
							ui.warn(`Branch "${branch}" was not deleted (not fully merged, use --force)`);
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
			}, ui);
		},
	});
}
