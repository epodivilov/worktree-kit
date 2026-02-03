import { defineCommand } from "citty";
import { createWorktree } from "../application/use-cases/create-worktree.ts";
import type { Container } from "../infrastructure/container.ts";
import { Result } from "../shared/result.ts";

export function createCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "create",
			description: "Create a new worktree with config sync",
		},
		args: {
			branch: {
				type: "positional",
				description: "Branch name for the new worktree",
				required: true,
			},
			base: {
				type: "string",
				alias: "b",
				description: "Base branch to create from",
				required: false,
			},
		},
		async run({ args }) {
			const { ui, git, fs } = container;

			ui.intro("worktree-kit create");

			const result = await createWorktree({ branch: args.branch, baseBranch: args.base }, { git, fs });

			if (Result.isErr(result)) {
				ui.error(result.error.message);
				process.exit(1);
			}

			ui.success(`Created worktree for branch: ${args.branch}`);
			ui.outro("Done!");
		},
	});
}
