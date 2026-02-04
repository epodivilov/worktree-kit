import { defineCommand, runMain } from "citty";
import { createCommand } from "./commands/create.ts";
import { initCommand } from "./commands/init.ts";
import { listCommand } from "./commands/list.ts";
import { removeCommand } from "./commands/remove.ts";
import { createContainer } from "./infrastructure/container.ts";

const container = createContainer();

const main = defineCommand({
	meta: {
		name: "wt",
		version: "0.1.0",
		description: "CLI tool for simplifying git-worktree workflow",
	},
	subCommands: {
		create: createCommand(container),
		list: listCommand(container),
		remove: removeCommand(container),
		init: initCommand(container),
	},
});

runMain(main);
