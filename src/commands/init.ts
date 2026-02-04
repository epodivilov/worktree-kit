import { defineCommand } from "citty";
import { initConfig } from "../application/use-cases/init-config.ts";
import type { Container } from "../infrastructure/container.ts";
import { Result } from "../shared/result.ts";

export function initCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "init",
			description: "Create .worktreekitrc config",
		},
		args: {
			force: {
				type: "boolean",
				alias: "f",
				description: "Overwrite existing config",
				default: false,
			},
		},
		async run({ args }) {
			const { ui, fs, git } = container;

			ui.intro("worktree-kit init");

			const result = await initConfig({ force: args.force }, { fs, git });

			if (Result.isErr(result)) {
				ui.error(result.error.message);
				process.exit(1);
			}

			ui.success(`Created config at: ${result.data.configPath}`);
			ui.outro("Done!");
		},
	});
}
