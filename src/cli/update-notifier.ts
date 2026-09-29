import { join } from "node:path";
import pc from "picocolors";
import { checkForUpdates, refreshUpdateCache } from "../application/use-cases/check-for-updates.ts";
import { createBunFilesystemAdapter } from "../infrastructure/adapters/bun-filesystem-adapter.ts";
import { createConsoleLoggerAdapter } from "../infrastructure/adapters/console-logger-adapter.ts";
import type { Container } from "../infrastructure/container.ts";
import { fetchLatestVersion } from "../infrastructure/github-releases.ts";
import { getCacheDir } from "../shared/xdg-paths.ts";

export const UPDATE_CHECK_FILENAME = "update-check.json";
export const UPDATE_REFRESH_FLAG = "--internal-refresh-update-cache";

const SKIP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);
// Commands for which the "update available" notice would be redundant or misleading.
// `self-update` mutates the binary mid-process; the exit-time notice captured a stale
// version in its closure and would print after a successful upgrade.
const SKIP_COMMANDS = new Set(["self-update"]);

export async function runUpdateNotifier(container: Pick<Container, "fs">, currentVersion: string): Promise<void> {
	if (!process.stdout.isTTY) return;
	if (process.argv.some((arg) => SKIP_FLAGS.has(arg) || SKIP_COMMANDS.has(arg))) return;

	const cachePath = join(getCacheDir(), UPDATE_CHECK_FILENAME);
	try {
		const result = await checkForUpdates({
			fs: container.fs,
			cachePath,
			currentVersion,
		});

		if (result.hasUpdate && result.latestVersion) {
			const latestVersion = result.latestVersion;
			process.on("exit", () => {
				const from = pc.dim(currentVersion);
				const to = pc.green(latestVersion);
				const cmd = pc.cyan("wt self-update");
				console.log(`\n${pc.yellow("◆")} Update available: ${from} → ${to}  ·  run ${cmd}`);
			});
		}

		if (!result.isFresh && !(process.argv.length === 3 && VERSION_FLAGS.has(process.argv[2] ?? ""))) {
			const standalone = (Bun as typeof Bun & { isStandaloneExecutable: boolean }).isStandaloneExecutable;
			const command = [process.execPath, ...(standalone ? [] : [Bun.main]), UPDATE_REFRESH_FLAG];
			Bun.spawn(command, { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
		}
	} catch {
		// Update checks must never change a foreground command's result.
	}
}

export async function runUpdateRefreshWorker(): Promise<void> {
	try {
		await refreshUpdateCache({
			fs: createBunFilesystemAdapter(createConsoleLoggerAdapter(false)),
			cachePath: join(getCacheDir(), UPDATE_CHECK_FILENAME),
			fetchLatest: () => fetchLatestVersion(),
		});
	} catch {
		// The detached worker is silent even when its refresh fails.
	}
}
