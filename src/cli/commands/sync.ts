import { defineCommand } from "citty";
import pc from "picocolors";
import * as v from "valibot";
import { loadConfig } from "../../application/use-cases/load-config.ts";
import { syncWorktrees } from "../../application/use-cases/sync-worktrees.ts";
import { INIT_ROOT_DIR } from "../../domain/constants.ts";
import type { WorktreeConfig } from "../../domain/entities/config.ts";
import { SyncArgsSchema } from "../../domain/schemas/command-args-schema.ts";
import type { Container } from "../../infrastructure/container.ts";
import { formatDisplayPath } from "../../shared/format-path.ts";
import { Result } from "../../shared/result.ts";
import { EXIT_FAILURE } from "../exit-codes.ts";
import { renderNotifications } from "../render-notifications.ts";
import { CommandError, runCommand } from "../run-command.ts";

export function syncCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "sync",
			description: "Apply config copy/symlink changes to existing worktrees",
		},
		args: {
			branch: {
				type: "positional",
				description: "Branch to sync. Syncs all worktrees if omitted",
				required: false,
			},
			"dry-run": {
				type: "boolean",
				description: "Show what would change without applying",
				required: false,
			},
			force: {
				type: "boolean",
				description: "Overwrite existing files at copy destinations",
				required: false,
			},
		},
		async run({ args }) {
			const { ui, git, fs, shell } = container;

			ui.intro("worktree-kit sync");

			await runCommand(async () => {
				const parsed = v.parse(SyncArgsSchema, args);
				const { branch, force } = parsed;
				const dryRun = parsed["dry-run"];

				const rootResult = await git.getMainWorktreeRoot();
				if (Result.isErr(rootResult)) {
					throw new CommandError(rootResult.error.message, EXIT_FAILURE);
				}
				const repoRoot = rootResult.data;

				const configResult = await loadConfig({ git, fs });
				let config: WorktreeConfig;
				let postSyncHooks: readonly string[];

				if (Result.isOk(configResult)) {
					config = configResult.data.config;
					postSyncHooks = config.hooks["post-sync"];
					if (configResult.data.isLegacyConfig) {
						ui.warn("Using legacy .worktreekitrc config. Run 'wt init --migrate' to upgrade to .worktreekit.jsonc");
					}
				} else {
					config = {
						rootDir: INIT_ROOT_DIR,
						copy: [],
						symlinks: [],
						hooks: { "post-create": [], "pre-remove": [], "post-update": [], "on-conflict": [], "post-sync": [] },
						defaultBase: "ask",
						create: {},
						remove: {},
					};
					postSyncHooks = [];
					ui.warn(configResult.error.message);
				}

				const spinner = ui.createSpinner();
				spinner.start(dryRun ? "Resolving sync plan..." : "Syncing worktrees...");

				const result = await syncWorktrees(
					{
						branch,
						dryRun,
						force,
						postSyncHooks,
						repoRoot,
						config,
						configResult: Result.isOk(configResult) ? configResult : null,
					},
					{ git, fs, shell: postSyncHooks.length > 0 ? shell : undefined },
				);

				if (Result.isErr(result)) {
					spinner.stop(pc.red("Failed"));
					throw new CommandError(result.error.message, EXIT_FAILURE);
				}

				spinner.stop(pc.green(dryRun ? "Plan ready" : "Done"));

				const { reports } = result.data;

				if (reports.length === 0) {
					ui.info("No worktrees to sync");
					ui.outro(dryRun ? "Dry run — no changes made" : "Done!");
					return;
				}

				const verb = (action: string) => (dryRun ? `would ${action}` : action);

				for (const report of reports) {
					const symCount = report.addedSymlinks.length;
					const fileCount = report.copiedFiles.length + report.overwrittenFiles.length;
					const display = formatDisplayPath(report.path, repoRoot);

					if (
						symCount === 0 &&
						report.recreatedSymlinks.length === 0 &&
						fileCount === 0 &&
						report.skippedFiles.length === 0
					) {
						ui.info(`${pc.bold(report.branch)} (${display}) — up to date`);
					} else {
						const parts: string[] = [];
						if (symCount > 0) parts.push(`${verb("add")} ${symCount} symlink(s)`);
						if (report.recreatedSymlinks.length > 0) {
							parts.push(`${verb("recreate")} ${report.recreatedSymlinks.length} broken symlink(s)`);
						}
						if (report.copiedFiles.length > 0) parts.push(`${verb("copy")} ${report.copiedFiles.length} file(s)`);
						if (report.overwrittenFiles.length > 0) {
							parts.push(`${verb("overwrite")} ${report.overwrittenFiles.length} file(s)`);
						}
						const summary = parts.length > 0 ? `: ${parts.join(", ")}` : "";
						ui.success(`${pc.bold(report.branch)} (${display})${summary}`);
					}

					if (report.skippedFiles.length > 0) {
						ui.warn(`  ${report.skippedFiles.length} file(s) already exist at destination — pass --force to overwrite`);
					}

					renderNotifications(ui, report.notifications);

					for (const note of report.hookNotifications) {
						if (note.level === "warn") ui.warn(`  ${note.message}`);
					}
				}

				ui.outro(dryRun ? "Dry run — no changes made" : "Done!");
			}, ui);
		},
	});
}
