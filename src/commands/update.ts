import { defineCommand } from "citty";
import pc from "picocolors";
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
			"dry-run": {
				type: "boolean",
				description: "Show what would be done without making changes",
				required: false,
			},
		},
		async run({ args }) {
			const { ui, git } = container;

			const dryRun = (args["dry-run"] as boolean | undefined) ?? false;

			ui.intro("worktree-kit update");

			const spinner = ui.createSpinner();
			spinner.start("Fetching and updating worktrees...");

			const result = await updateWorktrees({ dryRun }, { git });

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
				switch (report.result.status) {
					case "is-default-branch":
						break;
					case "rebased":
						ui.success(`${report.branch} rebased onto ${onto}`);
						break;
					case "rebased-dirty":
						ui.success(`${report.branch} rebased onto ${onto} (via WIP commit)`);
						break;
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
