import { defineCommand } from "citty";
import pc from "picocolors";
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
				const currentRootResult = await git.getRepositoryRoot();
				const currentPath = Result.isOk(currentRootResult) ? currentRootResult.data : null;

				for (const wt of result.data.worktrees) {
					const isCurrent = currentPath && wt.path === currentPath;

					const icon = isCurrent ? pc.green("◆") : pc.dim("◇");
					const name = isCurrent ? pc.green(wt.branch) : wt.branch;
					const badges = [wt.isMain && pc.cyan("(main)"), isCurrent && pc.green("(current)")].filter(Boolean).join(" ");
					const marker = badges ? ` ${badges}` : "";
					const path = pc.dim(`    ${wt.path}`);

					ui.info(`${icon} ${name}${marker}\n${path}`);
				}
			}

			ui.outro("Done!");
		},
	});
}
