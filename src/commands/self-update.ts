import { defineCommand } from "citty";
import pc from "picocolors";
import pkg from "../../package.json";
import type { Container } from "../infrastructure/container.ts";
import { fetchLatestVersion, type LatestRelease } from "../infrastructure/github-releases.ts";

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

function formatMb(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(1);
}

async function downloadBinary(
	tag: string,
	binaryName: string,
	targetPath: string,
	onProgress?: (downloaded: number, total: number) => void,
): Promise<void> {
	const url = `https://github.com/${REPO}/releases/download/${tag}/${binaryName}`;

	let res: Response;
	try {
		res = await fetch(url, {
			redirect: "follow",
			signal: AbortSignal.timeout(120_000),
		});
	} catch (err) {
		if (err instanceof Error && err.name === "TimeoutError") {
			throw new Error("Download timed out");
		}
		throw err;
	}

	if (!res.ok) {
		throw new Error(`Download failed: ${res.status} ${res.statusText}`);
	}

	if (!res.body) {
		throw new Error("Download failed: empty response body");
	}

	const total = Number(res.headers.get("content-length") ?? 0);
	const tmpPath = `${targetPath}.tmp`;
	const writer = Bun.file(tmpPath).writer();

	let downloaded = 0;
	try {
		for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
			writer.write(chunk);
			downloaded += chunk.byteLength;
			onProgress?.(downloaded, total);
		}
		await writer.end();
	} catch (err) {
		try {
			await writer.end();
		} catch {
			// ignore cleanup error
		}
		throw err;
	}

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

			let latest: LatestRelease;
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
				let lastRender = 0;
				await downloadBinary(latest.tag, binaryName, execPath, (downloaded, total) => {
					const now = Date.now();
					if (now - lastRender < 200) return;
					lastRender = now;
					const current = formatMb(downloaded);
					const message =
						total > 0
							? `Downloading ${latest.tag}... ${current}/${formatMb(total)} MB`
							: `Downloading ${latest.tag}... ${current} MB`;
					spinner.message(message);
				});
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
