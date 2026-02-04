import { defineCommand, runMain } from "citty";
import pkg from "../package.json";
import { createCommand } from "./commands/create.ts";
import { initCommand } from "./commands/init.ts";
import { listCommand } from "./commands/list.ts";
import { removeCommand } from "./commands/remove.ts";
import { createContainer } from "./infrastructure/container.ts";

const verbose = process.argv.includes("--verbose") || process.env.WT_VERBOSE === "1";

const container = createContainer({ verbose });

const main = defineCommand({
	meta: {
		name: "wt",
		version: pkg.version,
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
