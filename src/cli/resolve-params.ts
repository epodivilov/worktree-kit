import type { DefaultBase } from "../domain/entities/config.ts";
import type { GitPort } from "../domain/ports/git-port.ts";
import type { UiPort } from "../domain/ports/ui-port.ts";
import { Result } from "../shared/result.ts";

function unwrapOrCancel<T>(ui: UiPort, value: T | symbol): T {
	if (ui.isCancel(value)) {
		ui.cancel();
		process.exit(0);
	}
	return value;
}

// --- create command ---

export interface ResolveBranchResult {
	branch: string;
	isNewBranch: boolean;
	isRemoteBranch: boolean;
}

export async function resolveBranch(
	flag: string | undefined,
	deps: { ui: UiPort; git: GitPort },
): Promise<ResolveBranchResult> {
	const { ui, git } = deps;

	if (flag) {
		const branchExistsResult = await git.branchExists(flag);
		if (Result.isErr(branchExistsResult)) {
			ui.error(branchExistsResult.error.message);
			process.exit(1);
		}
		if (branchExistsResult.data) {
			return { branch: flag, isNewBranch: false, isRemoteBranch: false };
		}

		const remoteBranchesResult = await git.listRemoteBranches();
		if (Result.isErr(remoteBranchesResult)) {
			ui.error(remoteBranchesResult.error.message);
			process.exit(1);
		}
		if (remoteBranchesResult.data.includes(flag)) {
			return { branch: flag, isNewBranch: false, isRemoteBranch: true };
		}

		return { branch: flag, isNewBranch: true, isRemoteBranch: false };
	}

	if (ui.nonInteractive) {
		ui.error("Branch name is required in non-interactive mode");
		process.exit(1);
	}

	const branchesResult = await git.listBranches();
	if (Result.isErr(branchesResult)) {
		ui.error(branchesResult.error.message);
		process.exit(1);
	}

	const remoteBranchesResult = await git.listRemoteBranches();
	if (Result.isErr(remoteBranchesResult)) {
		ui.error(remoteBranchesResult.error.message);
		process.exit(1);
	}

	const worktreesResult = await git.listWorktrees();
	if (Result.isErr(worktreesResult)) {
		ui.error(worktreesResult.error.message);
		process.exit(1);
	}

	const usedBranches = new Set(worktreesResult.data.map((w) => w.branch));
	const localBranches = new Set(branchesResult.data);
	const availableLocalBranches = branchesResult.data.filter((b) => !usedBranches.has(b));
	const availableRemoteBranches = remoteBranchesResult.data.filter(
		(b) => !localBranches.has(b) && !usedBranches.has(b),
	);

	const CREATE_NEW = "__create_new__";
	const REMOTE_BRANCHES = "__remote_branches__";

	const firstLevelOptions: Array<{ value: string; label: string; hint?: string }> = [
		{ value: CREATE_NEW, label: "Create new branch", hint: "Enter a new branch name" },
		...availableLocalBranches.map((b) => ({ value: b, label: b })),
	];

	if (availableRemoteBranches.length > 0) {
		firstLevelOptions.push({
			value: REMOTE_BRANCHES,
			label: "Remote branches...",
			hint: `${availableRemoteBranches.length} available`,
		});
	}

	const selected = unwrapOrCancel(
		ui,
		await ui.select<string>({
			message: "Select branch for worktree",
			options: firstLevelOptions,
		}),
	);

	if (selected === CREATE_NEW) {
		const newBranch = unwrapOrCancel(
			ui,
			await ui.text({
				message: "Enter new branch name",
				placeholder: "feature/my-feature",
			}),
		);
		return { branch: newBranch, isNewBranch: true, isRemoteBranch: false };
	}

	if (selected === REMOTE_BRANCHES) {
		const remoteBranch = unwrapOrCancel(
			ui,
			await ui.select<string>({
				message: "Select remote branch",
				options: availableRemoteBranches.map((b) => ({ value: b, label: b })),
			}),
		);
		return { branch: remoteBranch, isNewBranch: false, isRemoteBranch: true };
	}

	return { branch: selected, isNewBranch: false, isRemoteBranch: false };
}

export async function resolveBaseBranch(
	flag: string | undefined,
	config: { base?: string; defaultBase: DefaultBase },
	deps: { ui: UiPort; git: GitPort },
): Promise<string | undefined> {
	if (flag) return flag;

	if (config.base) return config.base;

	const { ui, git } = deps;

	if (config.defaultBase === "current") return undefined;

	if (config.defaultBase === "default") {
		const defaultBranchResult = await git.getDefaultBranch();
		if (Result.isOk(defaultBranchResult)) {
			return defaultBranchResult.data;
		}
		return undefined;
	}

	// defaultBase === "ask"
	if (ui.nonInteractive) {
		const defaultBranch = await git.getDefaultBranch();
		return Result.isOk(defaultBranch) ? defaultBranch.data : undefined;
	}

	const branchesResult = await git.listBranches();
	if (Result.isErr(branchesResult) || branchesResult.data.length === 0) {
		return undefined;
	}

	const defaultBranchResult = await git.getDefaultBranch();
	const defaultBranchName = Result.isOk(defaultBranchResult) ? defaultBranchResult.data : undefined;

	const options = branchesResult.data.map((b) => ({
		value: b,
		label: b,
		hint: b === defaultBranchName ? "default" : undefined,
	}));

	if (defaultBranchName) {
		const idx = options.findIndex((o) => o.value === defaultBranchName);
		if (idx > 0) {
			options.unshift(...options.splice(idx, 1));
		}
	}

	return unwrapOrCancel(
		ui,
		await ui.select<string>({
			message: "Select source branch",
			options,
		}),
	);
}

// --- remove command ---

export async function resolveBranchesToRemove(
	flag: string | undefined,
	deps: { ui: UiPort; git: GitPort },
): Promise<string[]> {
	if (flag) return [flag];

	const { ui, git } = deps;

	if (ui.nonInteractive) {
		ui.error("Branch name is required in non-interactive mode");
		process.exit(1);
	}

	const worktreesResult = await git.listWorktrees();
	if (Result.isErr(worktreesResult)) {
		ui.error(worktreesResult.error.message);
		process.exit(1);
	}

	const removable = worktreesResult.data.filter((w) => !w.isMain);

	if (removable.length === 0) {
		ui.info("No worktrees to remove");
		ui.outro("Done!");
		process.exit(0);
	}

	const options = removable.map((w) => ({
		value: w.branch,
		label: w.branch,
		hint: w.path,
	}));

	const selected = unwrapOrCancel(
		ui,
		await ui.multiselect<string>({
			message: "Select worktrees to remove",
			options,
			required: true,
		}),
	);

	return selected;
}

export async function resolveDeleteRemoteBranch(
	flag: boolean | undefined,
	configValue: boolean | undefined,
	deps: { ui: UiPort },
	context: { branches: string[] },
): Promise<boolean> {
	if (flag !== undefined) return flag;

	if (configValue !== undefined) return configValue;

	const { ui } = deps;

	if (ui.nonInteractive) return false;

	const message =
		context.branches.length > 1
			? `Also delete ${context.branches.length} remote branches?`
			: `Also delete remote branch "${context.branches[0]}"?`;

	return unwrapOrCancel(ui, await ui.confirm({ message, initialValue: false }));
}

export async function resolveDeleteBranch(
	flag: boolean | undefined,
	configValue: boolean | undefined,
	deps: { ui: UiPort },
	context: { branches: string[] },
): Promise<boolean> {
	if (flag !== undefined) return flag;

	if (configValue !== undefined) return configValue;

	const { ui } = deps;

	if (ui.nonInteractive) return false;

	const message =
		context.branches.length > 1
			? `Also delete ${context.branches.length} branches?`
			: `Also delete branch "${context.branches[0]}"?`;

	return unwrapOrCancel(ui, await ui.confirm({ message, initialValue: false }));
}
