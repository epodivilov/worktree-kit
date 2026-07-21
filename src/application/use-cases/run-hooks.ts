import type { ShellPort } from "../../domain/ports/shell-port.ts";
import { Notification as N, type Notification } from "../../shared/notification.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";

export interface HookContext {
	worktreePath: string;
	branch: string;
	repoRoot: string;
	baseBranch?: string;
}

export interface RunHooksInput {
	commands: readonly string[];
	context: HookContext;
}

export interface RunHooksOutput {
	notifications: Notification[];
	failedCommands: string[];
}

export interface RunHooksDeps {
	shell: ShellPort;
}

export async function runHooks(input: RunHooksInput, deps: RunHooksDeps): Promise<Result<RunHooksOutput, Error>> {
	const { commands, context } = input;
	const { shell } = deps;

	const notifications: Notification[] = [];
	const failedCommands: string[] = [];

	const env = {
		WORKTREE_PATH: context.worktreePath,
		WORKTREE_BRANCH: context.branch,
		REPO_ROOT: context.repoRoot,
		...(context.baseBranch && { BASE_BRANCH: context.baseBranch }),
	};

	for (const [index, command] of commands.entries()) {
		const result = await shell.execute(command, {
			cwd: context.worktreePath,
			env,
		});

		if (result.success) {
			notifications.push(N.info(`Hook completed: "${command}"`));
			continue;
		}

		// No shell means no hook can ever run — report once and stop instead of
		// repeating the same failure for every remaining command.
		if (result.error.code === "SHELL_UNAVAILABLE") {
			const skipped = commands.slice(index);
			failedCommands.push(...skipped);
			notifications.push(N.warn(`Skipped ${skipped.length} hook(s): ${result.error.message}`));
			break;
		}

		failedCommands.push(command);
		notifications.push(N.warn(`Hook failed: "${command}" - ${result.error.message}`));
	}

	return R.ok({ notifications, failedCommands });
}
