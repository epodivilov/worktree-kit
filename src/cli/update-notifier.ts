import { join } from "node:path";
import pc from "picocolors";
import { checkForUpdates, refreshUpdateCache } from "../application/use-cases/check-for-updates.ts";
import type { Container } from "../infrastructure/container.ts";
import { fetchLatestVersion } from "../infrastructure/github-releases.ts";
import { getCacheDir } from "../shared/xdg-paths.ts";

export const UPDATE_CHECK_FILENAME = "update-check.json";

const SKIP_FLAGS = new Set(["--help", "-h", "--version", "-v"]);
// Commands for which the "update available" notice would be redundant or misleading.
// `self-update` mutates the binary mid-process; the exit-time notice captured a stale
// version in its closure and would print after a successful upgrade.
const SKIP_COMMANDS = new Set(["self-update"]);

export async function runUpdateNotifier(container: Container, currentVersion: string): Promise<void> {
	if (!process.stdout.isTTY) return;
	if (process.argv.some((arg) => SKIP_FLAGS.has(arg) || SKIP_COMMANDS.has(arg))) return;

	const cachePath = join(getCacheDir(), UPDATE_CHECK_FILENAME);

	const result = await checkForUpdates({
		fs: container.fs,
		cachePath,
		currentVersion,
	});

	if (result.hasUpdate && result.latestVersion && process.stdout.isTTY) {
		const latestVersion = result.latestVersion;
		process.on("exit", () => {
			const from = pc.dim(currentVersion);
			const to = pc.green(latestVersion);
			const cmd = pc.cyan("wt self-update");
			console.log(`\n${pc.yellow("◆")} Update available: ${from} → ${to}  ·  run ${cmd}`);
		});
	}

	if (!result.isFresh) {
		void refreshUpdateCache({
			fs: container.fs,
			cachePath,
			fetchLatest: fetchLatestVersion,
		});
	}
}
