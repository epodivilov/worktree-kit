import type { Result } from "../../shared/result.ts";

export interface ShellError {
	/**
	 * `SHELL_UNAVAILABLE` — the platform provides no POSIX shell to run the command with.
	 * Commands are shell strings, so there is no fallback: callers should report and skip.
	 */
	readonly code: "EXECUTION_FAILED" | "TIMEOUT" | "SHELL_UNAVAILABLE" | "UNKNOWN";
	readonly message: string;
	readonly exitCode?: number;
	readonly stderr?: string;
}

export interface ShellExecuteOptions {
	readonly cwd: string;
	readonly env?: Record<string, string>;
	readonly timeout?: number;
}

export interface ShellExecuteResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

export interface ShellPort {
	execute(command: string, options: ShellExecuteOptions): Promise<Result<ShellExecuteResult, ShellError>>;
}
