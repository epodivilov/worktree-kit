import { defineCommand } from "citty";
import { initConfig } from "../application/use-cases/init-config.ts";
import { CommandError, runCommand } from "../cli/run-command.ts";
import type { Container } from "../infrastructure/container.ts";
import { Result } from "../shared/result.ts";

export function initCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "init",
			description: "Create .worktreekit.jsonc config",
		},
		args: {
			force: {
				type: "boolean",
				alias: "f",
				description: "Overwrite existing config",
				default: false,
			},
			migrate: {
				type: "boolean",
				alias: "m",
				description: "Rename legacy .worktreekitrc to .worktreekit.jsonc",
				default: false,
			},
		},
		async run({ args }) {
			const { ui, fs, git } = container;

			ui.intro("worktree-kit init");

			await runCommand(async () => {
				const result = await initConfig({ force: args.force, migrate: args.migrate }, { fs, git });

				if (Result.isErr(result)) {
					throw new CommandError(result.error.message);
				}

				const action = args.migrate ? "Migrated config to" : "Created config at";
				ui.success(`${action}: ${result.data.configPath}`);
				ui.outro("Done!");
			}, ui);
		},
	});
}
