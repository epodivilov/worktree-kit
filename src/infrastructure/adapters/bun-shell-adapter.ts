import type { LoggerPort } from "../../domain/ports/logger-port.ts";
import type { ShellError, ShellExecuteOptions, ShellExecuteResult, ShellPort } from "../../domain/ports/shell-port.ts";
import { Result } from "../../shared/result.ts";

const DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

export function createBunShellAdapter(logger: LoggerPort): ShellPort {
	return {
		async execute(command: string, options: ShellExecuteOptions): Promise<Result<ShellExecuteResult, ShellError>> {
			const { cwd, env = {}, timeout = DEFAULT_TIMEOUT } = options;

			logger.debug("shell", command);
			logger.debug("shell", `cwd: ${cwd}`);

			const startTime = Date.now();

			try {
				const proc = Bun.spawn(["sh", "-c", command], {
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
