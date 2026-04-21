import { join } from "node:path";
import pc from "picocolors";
import { checkForUpdates, refreshUpdateCache } from "../application/use-cases/check-for-updates.ts";
import type { Container } from "../infrastructure/container.ts";
import { fetchLatestVersion } from "../infrastructure/github-releases.ts";
import { getCacheDir } from "../shared/xdg-paths.ts";

const UPDATE_CHECK_FILENAME = "update-check.json";

export async function runUpdateNotifier(container: Container, currentVersion: string): Promise<void> {
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
