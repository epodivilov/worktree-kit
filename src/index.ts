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
import { GLOBAL_ARGS } from "./cli/global-args.ts";
import { resolveNonInteractive } from "./cli/resolve-non-interactive.ts";
import { runUpdateNotifier, runUpdateRefreshWorker, UPDATE_REFRESH_FLAG } from "./cli/update-notifier.ts";
import { createBunFilesystemAdapter } from "./infrastructure/adapters/bun-filesystem-adapter.ts";
import { createConsoleLoggerAdapter } from "./infrastructure/adapters/console-logger-adapter.ts";
import { type Container, createContainer } from "./infrastructure/container.ts";

let container: Container;

const main = defineCommand({
	meta: {
		name: "wt",
		version: pkg.version,
		description: "CLI tool for simplifying git-worktree workflow",
	},
	args: {
		...GLOBAL_ARGS,
	},
	async setup({ args }) {
		container = await createContainer({
			verbose: args.verbose || process.env.WT_VERBOSE === "1",
			// Detect non-TTY here (not at module load) so unit tests, which never
			// read process.std*.isTTY, stay unaffected.
			nonInteractive: resolveNonInteractive({
				flag: args["non-interactive"],
				env: process.env.WT_NON_INTERACTIVE,
				stdinIsTTY: process.stdin.isTTY,
				stdoutIsTTY: process.stdout.isTTY,
			}),
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

if (process.argv.length === 3 && process.argv[2] === UPDATE_REFRESH_FLAG) {
	await runUpdateRefreshWorker();
} else {
	// Citty handles --version before setup, so read the cached notice here.
	const versionFlag = process.argv[2];
	if (process.argv.length === 3 && versionFlag && ["--version", "-v"].includes(versionFlag)) {
		await runUpdateNotifier({ fs: createBunFilesystemAdapter(createConsoleLoggerAdapter(false)) }, pkg.version);
	}
	await runMain(main);
}
