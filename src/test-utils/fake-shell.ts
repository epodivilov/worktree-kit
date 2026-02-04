import type { ShellError, ShellExecuteOptions, ShellExecuteResult, ShellPort } from "../domain/ports/shell-port.ts";
import { Result } from "../shared/result.ts";

export interface FakeShellCall {
	command: string;
	options: ShellExecuteOptions;
}

export interface FakeShellOptions {
	results?: Map<string, Result<ShellExecuteResult, ShellError>>;
	defaultResult?: Result<ShellExecuteResult, ShellError>;
}

export interface FakeShell extends ShellPort {
	readonly calls: FakeShellCall[];
}

export function createFakeShell(options: FakeShellOptions = {}): FakeShell {
	const { results = new Map(), defaultResult = Result.ok({ stdout: "", stderr: "", exitCode: 0 }) } = options;

	const calls: FakeShellCall[] = [];

	return {
		calls,
		async execute(command: string, options: ShellExecuteOptions): Promise<Result<ShellExecuteResult, ShellError>> {
			calls.push({ command, options });
			return results.get(command) ?? defaultResult;
		},
	};
}
