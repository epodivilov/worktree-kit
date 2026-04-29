import { resolve } from "node:path";
import { defineCommand } from "citty";
import pc from "picocolors";
import { cleanupWorktrees } from "../application/use-cases/cleanup-worktrees.ts";
import { listWorktrees } from "../application/use-cases/list-worktrees.ts";
import { loadConfig } from "../application/use-cases/load-config.ts";
import { CommandError, runCommand } from "../cli/run-command.ts";
import { INIT_ROOT_DIR } from "../domain/constants.ts";
import type { Container } from "../infrastructure/container.ts";
import { Result } from "../shared/result.ts";

export function cleanupCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "cleanup",
			description: "Remove worktrees and branches whose remote tracking branch is gone",
		},
		args: {
			force: {
				type: "boolean",
				description: "Delete branches even if they have unmerged changes",
				required: false,
			},
			"dry-run": {
				type: "boolean",
				description: "Show what would be done without making changes",
				required: false,
			},
		},
		async run({ args }) {
			const { ui, git, fs } = container;

			ui.intro("worktree-kit cleanup");

			await runCommand(async () => {
				const force = (args.force as boolean | undefined) ?? false;
				const dryRun = (args["dry-run"] as boolean | undefined) ?? false;

				// Discovery pass
				const spinner = ui.createSpinner();
				spinner.start("Fetching and pruning remote branches...");

				const discoveryResult = await cleanupWorktrees({ force, dryRun: true }, { git });

				if (Result.isErr(discoveryResult)) {
					spinner.stop(pc.red("Failed"));
					throw new CommandError(discoveryResult.error.message);
				}

				const candidates = discoveryResult.data.reports;

				if (candidates.length === 0) {
					spinner.stop(pc.green("Up to date"));
					ui.info("Nothing to clean up");
					ui.outro("Done!");
					return;
				}

				spinner.stop(pc.green(`Found ${candidates.length} branch(es) to clean up`));

				for (const report of candidates) {
					const wtLabel = report.worktreePath ? ` (worktree: ${report.worktreePath})` : "";
					ui.info(`  ${pc.bold(report.branch)}${wtLabel}`);
				}

				if (dryRun) {
					ui.outro("Dry run — no changes made");
					return;
				}

				// Confirm
				if (!ui.nonInteractive) {
					const confirmed = await ui.confirm({
						message: "Proceed with cleanup?",
						initialValue: false,
					});

					if (ui.isCancel(confirmed) || !confirmed) {
						ui.cancel("Cleanup cancelled");
						process.exit(0);
					}
				}

				// Execute
				const execSpinner = ui.createSpinner();
				execSpinner.start("Cleaning up...");

				const execResult = await cleanupWorktrees({ force, dryRun: false }, { git });

				if (Result.isErr(execResult)) {
					execSpinner.stop(pc.red("Failed"));
					throw new CommandError(execResult.error.message);
				}

				execSpinner.stop(pc.green("Cleanup complete"));

				for (const report of execResult.data.reports) {
					switch (report.result.status) {
						case "cleaned":
							ui.success(`${report.branch} — worktree and branch removed`);
							break;
						case "branch-only":
							ui.success(`${report.branch} — branch removed`);
							break;
						case "skipped-unmerged":
							ui.warn(`${report.branch} — skipped (not fully merged, use --force)`);
							break;
						case "skipped-dirty":
							ui.warn(`${report.branch} — skipped (worktree has uncommitted changes)`);
							break;
						case "error":
							ui.error(`${report.branch} — ${report.result.message}`);
							break;
					}
				}

				// Clean up empty worktrees directory
				const remainingResult = await listWorktrees({ git });
				if (Result.isOk(remainingResult)) {
					const nonMainWorktrees = remainingResult.data.worktrees.filter((w) => !w.isMain);

					if (nonMainWorktrees.length === 0) {
						const configResult = await loadConfig({ fs, git });
						if (Result.isOk(configResult) && configResult.data.isLegacyConfig) {
							ui.warn("Using legacy .worktreekitrc config. Run 'wt init --migrate' to upgrade to .worktreekit.jsonc");
						}
						const rootDir = Result.isOk(configResult) ? configResult.data.config.rootDir : INIT_ROOT_DIR;

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
			}, ui);
		},
	});
}
