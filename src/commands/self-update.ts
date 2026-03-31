import { defineCommand } from "citty";
import pc from "picocolors";
import pkg from "../../package.json";
import type { Container } from "../infrastructure/container.ts";

const REPO = "epodivilov/worktree-kit";

function detectBinaryName(): string {
	const platform = process.platform;
	const arch = process.arch;

	const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
	const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;

	if (!os || !cpu) {
		throw new Error(`Unsupported platform: ${platform}/${arch}`);
	}

	return `wt-${os}-${cpu}`;
}

async function fetchLatestVersion(): Promise<{ tag: string; version: string }> {
	const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
		headers: { Accept: "application/vnd.github+json" },
	});

	if (!res.ok) {
		throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
	}

	const data = (await res.json()) as { tag_name: string };
	const tag = data.tag_name;
	const version = tag.startsWith("v") ? tag.slice(1) : tag;

	return { tag, version };
}

async function downloadBinary(tag: string, binaryName: string, targetPath: string): Promise<void> {
	const url = `https://github.com/${REPO}/releases/download/${tag}/${binaryName}`;
	const res = await fetch(url, { redirect: "follow" });

	if (!res.ok) {
		throw new Error(`Download failed: ${res.status} ${res.statusText}`);
	}

	const tmpPath = `${targetPath}.tmp`;

	await Bun.write(tmpPath, res);

	const { rename, chmod } = await import("node:fs/promises");
	await chmod(tmpPath, 0o755);
	await rename(tmpPath, targetPath);

	if (process.platform === "darwin") {
		try {
			Bun.spawnSync(["xattr", "-d", "com.apple.quarantine", targetPath]);
		} catch {
			// ignore — quarantine attribute may not exist
		}
	}
}

export function selfUpdateCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "self-update",
			description: "Update worktree-kit to the latest version",
		},
		async run() {
			const { ui } = container;

			ui.intro("worktree-kit self-update");

			const currentVersion = pkg.version;
			const spinner = ui.createSpinner();

			spinner.start("Checking for updates...");

			let latest: { tag: string; version: string };
			try {
				latest = await fetchLatestVersion();
			} catch (err) {
				spinner.stop(pc.red("Failed"));
				ui.error(err instanceof Error ? err.message : "Failed to check for updates");
				process.exit(1);
			}

			if (latest.version === currentVersion) {
				spinner.stop(pc.green("Up to date"));
				ui.success(`Already on the latest version (${currentVersion})`);
				ui.outro("Nothing to do");
				return;
			}

			spinner.message(`Downloading ${latest.tag}...`);

			let binaryName: string;
			try {
				binaryName = detectBinaryName();
			} catch (err) {
				spinner.stop(pc.red("Failed"));
				ui.error(err instanceof Error ? err.message : "Unsupported platform");
				process.exit(1);
			}

			const execPath = process.execPath;

			try {
				await downloadBinary(latest.tag, binaryName, execPath);
			} catch (err) {
				spinner.stop(pc.red("Failed"));
				ui.error(err instanceof Error ? err.message : "Download failed");
				process.exit(1);
			}

			spinner.stop(pc.green("Updated"));
			ui.success(`${currentVersion} → ${latest.version}`);
			ui.outro("Done!");
		},
	});
}
