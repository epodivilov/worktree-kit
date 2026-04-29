import { defineCommand } from "citty";
import pc from "picocolors";
import pkg from "../../package.json";
import { CommandError, runCommand } from "../cli/run-command.ts";
import type { Container } from "../infrastructure/container.ts";
import { fetchLatestVersion } from "../infrastructure/github-releases.ts";
import { Result as R, type Result } from "../shared/result.ts";

const REPO = "epodivilov/worktree-kit";

function detectBinaryName(): Result<string> {
	const platform = process.platform;
	const arch = process.arch;

	const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
	const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;

	if (!os || !cpu) {
		return R.err(new Error(`Unsupported platform: ${platform}/${arch}`));
	}

	return R.ok(`wt-${os}-${cpu}`);
}

function formatMb(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(1);
}

async function downloadBinary(
	tag: string,
	binaryName: string,
	targetPath: string,
	onProgress?: (downloaded: number, total: number) => void,
): Promise<Result<void>> {
	const url = `https://github.com/${REPO}/releases/download/${tag}/${binaryName}`;

	let res: Response;
	try {
		res = await fetch(url, {
			redirect: "follow",
			signal: AbortSignal.timeout(120_000),
		});
	} catch (err) {
		if (err instanceof Error && err.name === "TimeoutError") {
			return R.err(new Error("Download timed out"));
		}
		return R.err(err instanceof Error ? err : new Error(String(err)));
	}

	if (!res.ok) {
		return R.err(new Error(`Download failed: ${res.status} ${res.statusText}`));
	}

	if (!res.body) {
		return R.err(new Error("Download failed: empty response body"));
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
		return R.err(err instanceof Error ? err : new Error(String(err)));
	}

	try {
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
	} catch (err) {
		return R.err(new Error(`Post-download setup failed: ${err instanceof Error ? err.message : String(err)}`));
	}

	return R.ok(undefined);
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

			await runCommand(async () => {
				const currentVersion = pkg.version;
				const spinner = ui.createSpinner();

				spinner.start("Checking for updates...");

				const latestResult = await fetchLatestVersion();
				if (R.isErr(latestResult)) {
					spinner.stop(pc.red("Failed"));
					throw new CommandError(latestResult.error.message);
				}
				const latest = latestResult.data;

				if (latest.version === currentVersion) {
					spinner.stop(pc.green("Up to date"));
					ui.success(`Already on the latest version (${currentVersion})`);
					ui.outro("Nothing to do");
					return;
				}

				spinner.message(`Downloading ${latest.tag}...`);

				const binaryResult = detectBinaryName();
				if (R.isErr(binaryResult)) {
					spinner.stop(pc.red("Failed"));
					throw new CommandError(binaryResult.error.message);
				}
				const binaryName = binaryResult.data;

				const execPath = process.execPath;

				let lastRender = 0;
				const downloadResult = await downloadBinary(latest.tag, binaryName, execPath, (downloaded, total) => {
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
				if (R.isErr(downloadResult)) {
					spinner.stop(pc.red("Failed"));
					throw new CommandError(downloadResult.error.message);
				}

				spinner.stop(pc.green("Updated"));
				ui.success(`${currentVersion} → ${latest.version}`);
				ui.outro("Done!");
			}, ui);
		},
	});
}
