import { join } from "node:path";
import { defineCommand } from "citty";
import pc from "picocolors";
import pkg from "../../../package.json";
import { writeUpdateCache } from "../../application/use-cases/check-for-updates.ts";
import type { Container } from "../../infrastructure/container.ts";
import { fetchLatestVersion } from "../../infrastructure/github-releases.ts";
import { Result as R, type Result } from "../../shared/result.ts";
import { getCacheDir } from "../../shared/xdg-paths.ts";
import { EXIT_FAILURE } from "../exit-codes.ts";
import { CommandError, runCommand } from "../run-command.ts";
import { UPDATE_CHECK_FILENAME } from "../update-notifier.ts";

const REPO = "epodivilov/worktree-kit";

export const WINDOWS_UNSUPPORTED_MESSAGE = "Windows is not supported by self-update; reinstall via install.ps1";

export function detectBinaryName(platform: NodeJS.Platform, arch: string): Result<string> {
	if (platform === "win32") {
		return R.err(new Error(WINDOWS_UNSUPPORTED_MESSAGE));
	}

	const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
	const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;

	if (!os || !cpu) {
		return R.err(new Error(`Unsupported platform: ${platform}/${arch}`));
	}

	return R.ok(`wt-${os}-${cpu}`);
}

/**
 * Best-effort removal of the macOS quarantine attribute from a freshly
 * downloaded binary. Failures (missing `xattr`, non-zero exit, or no
 * attribute present) must NOT fail the self-update — they only surface
 * as a warning so the user knows why the binary might be Gatekeeper-blocked.
 */
export type QuarantineRemover = (targetPath: string) => Result<void>;

export const defaultQuarantineRemover: QuarantineRemover = (targetPath) => {
	try {
		const proc = Bun.spawnSync(["xattr", "-d", "com.apple.quarantine", targetPath]);
		if (proc.exitCode !== 0) {
			const stderr = proc.stderr?.toString().trim();
			return R.err(new Error(stderr || `xattr exited with code ${proc.exitCode}`));
		}
		return R.ok(undefined);
	} catch (err) {
		return R.err(err instanceof Error ? err : new Error(String(err)));
	}
};

export function tryRemoveMacosQuarantine(
	targetPath: string,
	deps: { remover: QuarantineRemover; warn: (message: string) => void },
): void {
	const result = deps.remover(targetPath);
	if (R.isErr(result)) {
		deps.warn(
			`Could not remove macOS quarantine attribute (${result.error.message}); macOS Gatekeeper may block the new binary until you run \`xattr -d com.apple.quarantine ${targetPath}\` manually.`,
		);
	}
}

function formatMb(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(1);
}

interface DownloadBinaryDeps {
	platform: NodeJS.Platform;
	quarantineRemover: QuarantineRemover;
	warn: (message: string) => void;
	onProgress?: (downloaded: number, total: number) => void;
}

async function downloadBinary(
	tag: string,
	binaryName: string,
	targetPath: string,
	deps: DownloadBinaryDeps,
): Promise<Result<void>> {
	const { platform, quarantineRemover, warn, onProgress } = deps;
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

		if (platform === "darwin") {
			tryRemoveMacosQuarantine(targetPath, { remover: quarantineRemover, warn });
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
			const { ui, fs } = container;

			ui.intro("worktree-kit self-update");

			await runCommand(async () => {
				const currentVersion = pkg.version;
				const spinner = ui.createSpinner();

				spinner.start("Checking for updates...");

				const latestResult = await fetchLatestVersion();
				if (R.isErr(latestResult)) {
					spinner.stop(pc.red("Failed"));
					throw new CommandError(latestResult.error.message, EXIT_FAILURE);
				}
				const latest = latestResult.data;

				if (latest.version === currentVersion) {
					spinner.stop(pc.green("Up to date"));
					ui.success(`Already on the latest version (${currentVersion})`);
					ui.outro("Nothing to do");
					return;
				}

				spinner.message(`Downloading ${latest.tag}...`);

				const binaryResult = detectBinaryName(process.platform, process.arch);
				if (R.isErr(binaryResult)) {
					spinner.stop(pc.red("Failed"));
					throw new CommandError(binaryResult.error.message, EXIT_FAILURE);
				}
				const binaryName = binaryResult.data;

				const execPath = process.execPath;

				let lastRender = 0;
				const downloadResult = await downloadBinary(latest.tag, binaryName, execPath, {
					platform: process.platform,
					quarantineRemover: defaultQuarantineRemover,
					warn: (message) => ui.warn(message),
					onProgress: (downloaded, total) => {
						const now = Date.now();
						if (now - lastRender < 200) return;
						lastRender = now;
						const current = formatMb(downloaded);
						const message =
							total > 0
								? `Downloading ${latest.tag}... ${current}/${formatMb(total)} MB`
								: `Downloading ${latest.tag}... ${current} MB`;
						spinner.message(message);
					},
				});
				if (R.isErr(downloadResult)) {
					spinner.stop(pc.red("Failed"));
					throw new CommandError(downloadResult.error.message, EXIT_FAILURE);
				}

				spinner.stop(pc.green("Updated"));

				// Refresh the update-check cache so the stale "update available" notice
				// does not appear on the next run. A failure here must not fail the update.
				await writeUpdateCache({
					fs,
					cachePath: join(getCacheDir(), UPDATE_CHECK_FILENAME),
					latestVersion: latest.version,
				});

				ui.success(`${currentVersion} → ${latest.version}`);
				ui.outro("Done!");
			}, ui);
		},
	});
}
