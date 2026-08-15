import { join } from "node:path";
import { defineCommand } from "citty";
import pc from "picocolors";
import pkg from "../../../package.json";
import { writeUpdateCache } from "../../application/use-cases/check-for-updates.ts";
import type { Container } from "../../infrastructure/container.ts";
import { fetchLatestVersion } from "../../infrastructure/github-releases.ts";
import { Result as R, type Result } from "../../shared/result.ts";
import { DEFAULT_MAX_ATTEMPTS, isTransientStatus, type RetryOutcome, withRetry } from "../../shared/retry.ts";
import { getCacheDir } from "../../shared/xdg-paths.ts";
import { EXIT_FAILURE } from "../exit-codes.ts";
import { GLOBAL_ARGS } from "../global-args.ts";
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
 * downloaded binary. Real failures (missing `xattr`, unexpected non-zero exit)
 * must NOT fail the self-update — they only surface as a warning so the user
 * knows why the binary might be Gatekeeper-blocked.
 */
export type QuarantineRemover = (targetPath: string) => Result<void>;

/**
 * Interpret the outcome of `xattr -d com.apple.quarantine`.
 *
 * A missing attribute is NOT a failure: the binary is fetched over HTTP, so
 * macOS never stamps it with `com.apple.quarantine` in the first place and
 * Gatekeeper has nothing to block. `xattr` reports this with a non-zero exit
 * and a "No such xattr" message, which we treat as success to avoid a
 * misleading warning that tells the user to re-run a command that would fail
 * the same way.
 */
export function interpretXattrRemoval(exitCode: number, stderr: string): Result<void> {
	if (exitCode === 0) {
		return R.ok(undefined);
	}
	const normalized = stderr.toLowerCase();
	if (
		normalized.includes("no such xattr") ||
		normalized.includes("attribute not found") ||
		normalized.includes("enoattr")
	) {
		return R.ok(undefined);
	}
	return R.err(new Error(stderr.trim() || `xattr exited with code ${exitCode}`));
}

export const defaultQuarantineRemover: QuarantineRemover = (targetPath) => {
	try {
		const proc = Bun.spawnSync(["xattr", "-d", "com.apple.quarantine", targetPath]);
		return interpretXattrRemoval(proc.exitCode, proc.stderr?.toString() ?? "");
	} catch (err) {
		return R.err(err instanceof Error ? err : new Error(String(err)));
	}
};

export function tryRemoveMacosQuarantine(
	targetPath: string,
	deps: { remover: QuarantineRemover; warn: (message: string) => void },
): void {
	let result: Result<void>;
	try {
		result = deps.remover(targetPath);
	} catch (err) {
		// Defensive: the contract says the remover returns a Result, but if an
		// injected/buggy remover throws synchronously, we must still degrade to
		// a warning rather than fail the update.
		result = R.err(err instanceof Error ? err : new Error(String(err)));
	}
	if (R.isErr(result)) {
		deps.warn(
			`Could not remove macOS quarantine attribute (${result.error.message}); macOS Gatekeeper may block the new binary until you run \`xattr -d com.apple.quarantine ${targetPath}\` manually.`,
		);
	}
}

function formatMb(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(1);
}

/**
 * Maximum number of binary-download attempts before `self-update` gives up.
 *
 * Aliases the shared {@link DEFAULT_MAX_ATTEMPTS}: the binary download and the
 * release-check fetch share one bounded-retry budget. Bun 1.3.x intermittently
 * throws a connection-level `fetch` error ("The socket connection was closed
 * unexpectedly") on the github.com 302 hop (WTK-59), so a bounded retry lets a
 * transient throw recover instead of failing the whole command. Re-exported for
 * the download-retry tests.
 */
export const MAX_DOWNLOAD_ATTEMPTS = DEFAULT_MAX_ATTEMPTS;

function toError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}

interface DownloadBinaryDeps {
	platform: NodeJS.Platform;
	quarantineRemover: QuarantineRemover;
	warn: (message: string) => void;
	onProgress?: (downloaded: number, total: number) => void;
	/** Injectable for tests; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Injectable backoff sleep; tests pass a no-op to avoid real timers. */
	sleep?: (ms: number) => Promise<void>;
}

export async function downloadBinary(
	tag: string,
	binaryName: string,
	targetPath: string,
	deps: DownloadBinaryDeps,
): Promise<Result<void>> {
	const { platform, quarantineRemover, warn, onProgress, fetchImpl = fetch, sleep } = deps;
	const url = `https://github.com/${REPO}/releases/download/${tag}/${binaryName}`;
	const tmpPath = `${targetPath}.tmp`;

	// One download attempt: fetch → classify status → stream to the tmp file →
	// install. Failures are classified as retriable/fatal exactly once here; the
	// shared `withRetry` below owns the single sleep/continue-vs-return decision.
	const attemptDownload = async (): Promise<RetryOutcome<void>> => {
		let res: Response;
		try {
			res = await fetchImpl(url, {
				redirect: "follow",
				// Per-attempt timeout: a hung attempt still aborts and then counts as a
				// failed attempt eligible for retry (TimeoutError is a thrown reject).
				signal: AbortSignal.timeout(120_000),
			});
		} catch (err) {
			// Network/connection throw: the request never produced a body, so a retry
			// simply re-issues `fetch` from scratch — no partial file to clean up.
			const error =
				err instanceof Error && err.name === "TimeoutError" ? new Error("Download timed out") : toError(err);
			return { kind: "retriable", error };
		}

		if (!res.ok) {
			const error = new Error(`Download failed: ${res.status} ${res.statusText}`);
			return isTransientStatus(res.status) ? { kind: "retriable", error } : { kind: "fatal", error };
		}

		if (!res.body) {
			return { kind: "fatal", error: new Error("Download failed: empty response body") };
		}

		const total = Number(res.headers.get("content-length") ?? 0);
		// Reset the tmp file to empty at the start of each streaming attempt so a
		// retry after a mid-stream failure rewrites rather than appends (Bun's
		// FileSink overwrites from offset 0 but does not truncate trailing bytes).
		await Bun.write(tmpPath, new Uint8Array(0));
		const writer = Bun.file(tmpPath).writer();

		// Reset per attempt so `onProgress` does not double-count across retries.
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
			// A mid-body drop on the same connection-level fault is retriable; the
			// next attempt truncates the tmp file before rewriting.
			return { kind: "retriable", error: toError(err) };
		}

		try {
			const { rename, chmod } = await import("node:fs/promises");
			await chmod(tmpPath, 0o755);
			await rename(tmpPath, targetPath);

			if (platform === "darwin") {
				tryRemoveMacosQuarantine(targetPath, { remover: quarantineRemover, warn });
			}
		} catch (err) {
			return {
				kind: "fatal",
				error: new Error(`Post-download setup failed: ${err instanceof Error ? err.message : String(err)}`),
			};
		}

		return { kind: "ok", value: undefined };
	};

	// Bounded retry: `ok`/`fatal` return immediately; a `retriable` attempt backs
	// off and re-attempts until MAX_DOWNLOAD_ATTEMPTS, then fails with the last
	// attempt's error. The shared bound and linear backoff apply by default.
	return withRetry(attemptDownload, { sleep });
}

export function selfUpdateCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "self-update",
			description: "Update worktree-kit to the latest version",
		},
		args: {
			...GLOBAL_ARGS,
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
