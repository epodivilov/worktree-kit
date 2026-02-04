import type { Result } from "../../shared/result.ts";

export interface ShellError {
	readonly code: "EXECUTION_FAILED" | "TIMEOUT" | "UNKNOWN";
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
