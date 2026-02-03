import { defineCommand } from "citty";
import { listWorktrees } from "../application/use-cases/list-worktrees.ts";
import type { Container } from "../infrastructure/container.ts";
import { Result } from "../shared/result.ts";

export function listCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "list",
			description: "List all worktrees",
		},
		args: {},
		async run() {
			const { ui, git } = container;

			ui.intro("worktree-kit list");

			const result = await listWorktrees({ git });

			if (Result.isErr(result)) {
				ui.error(result.error.message);
				process.exit(1);
			}

			if (result.data.worktrees.length === 0) {
				ui.info("No worktrees found");
			} else {
				for (const wt of result.data.worktrees) {
					ui.info(`${wt.branch} -> ${wt.path}`);
				}
			}

			ui.outro("Done!");
		},
	});
}
