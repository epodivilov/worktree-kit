import { defineCommand, runMain } from "citty";
import pkg from "../package.json";
import { runUpdateNotifier } from "./cli/update-notifier.ts";
import { cleanupCommand } from "./commands/cleanup.ts";
import { createCommand } from "./commands/create.ts";
import { initCommand } from "./commands/init.ts";
import { listCommand } from "./commands/list.ts";
import { removeCommand } from "./commands/remove.ts";
import { selfUpdateCommand } from "./commands/self-update.ts";
import { updateCommand } from "./commands/update.ts";
import { type Container, createContainer } from "./infrastructure/container.ts";

let container: Container;

const main = defineCommand({
	meta: {
		name: "wt",
		version: pkg.version,
		description: "CLI tool for simplifying git-worktree workflow",
	},
	args: {
		verbose: {
			type: "boolean",
			default: false,
			description: "Enable verbose logging",
		},
		"non-interactive": {
			type: "boolean",
			default: false,
			description: "Disable interactive prompts",
		},
	},
	async setup({ args }) {
		container = createContainer({
			verbose: args.verbose || process.env.WT_VERBOSE === "1",
			nonInteractive: args["non-interactive"] || process.env.WT_NON_INTERACTIVE === "1",
		});
		await runUpdateNotifier(container, pkg.version);
	},
	subCommands: () => ({
		create: createCommand(container),
		list: listCommand(container),
		remove: removeCommand(container),
		update: updateCommand(container),
		"self-update": selfUpdateCommand(container),
		init: initCommand(container),
		cleanup: cleanupCommand(container),
	}),
});

runMain(main);
