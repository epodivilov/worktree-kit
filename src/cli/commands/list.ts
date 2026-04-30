import { defineCommand } from "citty";
import pc from "picocolors";
import { listWorktrees } from "../../application/use-cases/list-worktrees.ts";
import type { Container } from "../../infrastructure/container.ts";
import { Result } from "../../shared/result.ts";
import { EXIT_FAILURE } from "../exit-codes.ts";
import { CommandError, runCommand } from "../run-command.ts";

export function listCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "list",
			description: "List all worktrees",
		},
		args: {
			json: {
				type: "boolean",
				default: false,
				description: "Output as JSON array",
			},
		},
		async run({ args }) {
			const { ui, git } = container;

			if (args.json) {
				const result = await listWorktrees({ git });

				if (Result.isErr(result)) {
					process.stderr.write(`${JSON.stringify({ error: result.error.message })}\n`);
					process.exit(EXIT_FAILURE);
				}

				const currentRootResult = await git.getRepositoryRoot();
				const currentPath = Result.isOk(currentRootResult) ? currentRootResult.data : null;

				const items = result.data.worktrees.map((wt) => ({
					branch: wt.branch,
					path: wt.path,
					isMain: wt.isMain,
					isCurrent: currentPath ? wt.path === currentPath : false,
				}));

				process.stdout.write(`${JSON.stringify(items)}\n`);
				return;
			}

			ui.intro("worktree-kit list");

			await runCommand(async () => {
				const result = await listWorktrees({ git });

				if (Result.isErr(result)) {
					throw new CommandError(result.error.message, EXIT_FAILURE);
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
						const badges = [wt.isMain && pc.cyan("(main)"), isCurrent && pc.green("(current)")]
							.filter(Boolean)
							.join(" ");
						const marker = badges ? ` ${badges}` : "";
						const path = pc.dim(`    ${wt.path}`);

						ui.info(`${icon} ${name}${marker}\n${path}`);
					}
				}

				ui.outro("Done!");
			}, ui);
		},
	});
}
