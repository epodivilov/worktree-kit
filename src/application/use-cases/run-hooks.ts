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

	for (const command of commands) {
		const result = await shell.execute(command, {
			cwd: context.worktreePath,
			env,
		});

		if (!result.success) {
			failedCommands.push(command);
			notifications.push(N.warn(`Hook failed: "${command}" - ${result.error.message}`));
		} else {
			notifications.push(N.info(`Hook completed: "${command}"`));
		}
	}

	return R.ok({ notifications, failedCommands });
}
