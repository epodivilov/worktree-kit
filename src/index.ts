import { defineCommand, runMain } from "citty";
import pkg from "../package.json";
import { cleanupCommand } from "./cli/commands/cleanup.ts";
import { configCommand } from "./cli/commands/config.ts";
import { createCommand } from "./cli/commands/create.ts";
import { doctorCommand } from "./cli/commands/doctor.ts";
import { initCommand } from "./cli/commands/init.ts";
import { listCommand } from "./cli/commands/list.ts";
import { removeCommand } from "./cli/commands/remove.ts";
import { selfUpdateCommand } from "./cli/commands/self-update.ts";
import { syncCommand } from "./cli/commands/sync.ts";
import { updateCommand } from "./cli/commands/update.ts";
import { runUpdateNotifier } from "./cli/update-notifier.ts";
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
		config: configCommand(container),
		doctor: doctorCommand(container),
		sync: syncCommand(container),
	}),
});

runMain(main);
