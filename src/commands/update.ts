import { defineCommand } from "citty";
import pc from "picocolors";
import { loadConfig } from "../application/use-cases/load-config.ts";
import { updateWorktrees } from "../application/use-cases/update-worktrees.ts";
import type { Container } from "../infrastructure/container.ts";
import { Result } from "../shared/result.ts";

export function updateCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "update",
			description: "Fetch, fast-forward default branch, and rebase feature branches",
		},
		args: {
			branch: {
				type: "positional",
				description: "Branch to update (with its sub-branches). Updates all if omitted",
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

			const branch = args.branch as string | undefined;
			const dryRun = (args["dry-run"] as boolean | undefined) ?? false;

			ui.intro("worktree-kit update");

			const configResult = await loadConfig({ git, fs });
			const postUpdateHooks = configResult.success ? configResult.data.config.hooks["post-update"] : [];
			const onConflictHooks = configResult.success ? configResult.data.config.hooks["on-conflict"] : [];

			let repoRoot = "";
			if (postUpdateHooks.length > 0 || onConflictHooks.length > 0) {
				const rootResult = await git.getRepositoryRoot();
				if (rootResult.success) {
					repoRoot = rootResult.data;
				}
			}

			const spinner = ui.createSpinner();
			spinner.start("Fetching and updating worktrees...");

			const needsShell = postUpdateHooks.length > 0 || onConflictHooks.length > 0;
			const result = await updateWorktrees(
				{ dryRun, branch, postUpdateHooks, onConflictHooks, repoRoot },
				{ git, shell: needsShell ? shell : undefined },
			);

			if (Result.isErr(result)) {
				spinner.stop(pc.red("Failed"));
				ui.error(result.error.message);
				process.exit(1);
			}

			spinner.stop(pc.green("Done"));

			const { defaultBranch, defaultBranchUpdate, reports } = result.data;

			if (defaultBranchUpdate === "ff-updated") {
				ui.success(`${defaultBranch} fast-forwarded`);
			} else {
				ui.success(`${defaultBranch} ref updated`);
			}

			for (const report of reports) {
				const onto = report.parent ?? defaultBranch;
				const hookFailures = report.hookNotifications.filter((n) => n.level === "warn");

				switch (report.result.status) {
					case "is-default-branch":
						break;
					case "rebased":
					case "rebased-dirty": {
						const suffix = report.result.status === "rebased-dirty" ? " (via WIP commit)" : "";
						if (hookFailures.length > 0) {
							const failMsgs = hookFailures.map((n) => n.message).join("; ");
							ui.warn(`${report.branch} rebased onto ${onto}${suffix} — ${failMsgs}`);
						} else {
							ui.success(`${report.branch} rebased onto ${onto}${suffix}`);
						}
						break;
					}
					case "rebase-conflict":
						ui.warn(`${report.branch} has conflicts, rebase aborted`);
						break;
					case "dry-run": {
						const suffix = report.result.dirty ? " (dirty, via WIP commit)" : "";
						ui.info(`${report.branch} would be rebased onto ${onto}${suffix}`);
						break;
					}
					case "skipped":
						ui.warn(`${report.branch} skipped: ${report.result.reason}`);
						break;
				}
			}

			ui.outro(dryRun ? "Dry run — no changes made" : "Done!");
		},
	});
}
