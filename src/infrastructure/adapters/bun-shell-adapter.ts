import type { LoggerPort } from "../../domain/ports/logger-port.ts";
import type { ShellError, ShellExecuteOptions, ShellExecuteResult, ShellPort } from "../../domain/ports/shell-port.ts";
import { Result } from "../../shared/result.ts";

const DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

const SHELL_UNAVAILABLE_MESSAGE =
	"no POSIX shell on PATH — commands are shell strings run via `sh -c`, which native Windows does not provide (run wt from Git Bash or WSL)";

/** Resolves an executable to its absolute path, or `null` when it is not on PATH. */
export type WhichFn = (command: string) => string | null;

export function createBunShellAdapter(logger: LoggerPort, which: WhichFn = (cmd) => Bun.which(cmd)): ShellPort {
	let shellPath: string | null | undefined;

	function resolveShell(): string | null {
		if (shellPath === undefined) {
			shellPath = which("sh");
			logger.debug("shell", `sh -> ${shellPath ?? "not found"}`);
		}
		return shellPath;
	}

	return {
		async execute(command: string, options: ShellExecuteOptions): Promise<Result<ShellExecuteResult, ShellError>> {
			const { cwd, env = {}, timeout = DEFAULT_TIMEOUT } = options;

			logger.debug("shell", command);
			logger.debug("shell", `cwd: ${cwd}`);

			const sh = resolveShell();
			if (sh === null) {
				logger.debug("shell", "-> SHELL_UNAVAILABLE");
				return Result.err({
					code: "SHELL_UNAVAILABLE",
					message: SHELL_UNAVAILABLE_MESSAGE,
				});
			}

			const startTime = Date.now();

			try {
				const proc = Bun.spawn([sh, "-c", command], {
					cwd,
					env: { ...process.env, ...env },
					stdout: "pipe",
					stderr: "pipe",
				});

				let timedOut = false;
				const timeoutId = setTimeout(() => {
					timedOut = true;
					proc.kill();
				}, timeout);

				const exitCode = await proc.exited;
				clearTimeout(timeoutId);

				const durationMs = Date.now() - startTime;

				if (timedOut) {
					logger.debug("shell", `-> TIMEOUT (${durationMs}ms)`);
					return Result.err({
						code: "TIMEOUT",
						message: `Command timed out after ${timeout}ms`,
					});
				}

				const stdout = await new Response(proc.stdout).text();
				const stderr = await new Response(proc.stderr).text();

				logger.debug("shell", `-> exit ${exitCode} (${durationMs}ms)`);

				if (exitCode !== 0) {
					return Result.err({
						code: "EXECUTION_FAILED",
						message: `Command failed with exit code ${exitCode}`,
						exitCode,
						stderr: stderr.trim(),
					});
				}

				return Result.ok({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode });
			} catch {
				logger.debug("shell", "-> EXCEPTION");
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to execute command",
				});
			}
		},
	};
}
