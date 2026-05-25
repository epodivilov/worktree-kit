import { defineCommand } from "citty";
import pc from "picocolors";
import { listWorktrees } from "../../application/use-cases/list-worktrees.ts";
import { loadConfig } from "../../application/use-cases/load-config.ts";
import type { Worktree } from "../../domain/entities/worktree.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { Container } from "../../infrastructure/container.ts";
import { Result } from "../../shared/result.ts";
import { isDrifted } from "../../shared/worktree-drift.ts";
import { EXIT_FAILURE } from "../exit-codes.ts";
import { CommandError, runCommand } from "../run-command.ts";

interface DriftContext {
	repoRoot: string;
	rootDir: string;
}

export interface ListItem {
	branch: string;
	path: string;
	isMain: boolean;
	isCurrent: boolean;
	drifted: boolean;
}

export function toListItem(wt: Worktree, currentPath: string | null, drift: DriftContext | null): ListItem {
	return {
		branch: wt.branch,
		path: wt.path,
		isMain: wt.isMain,
		isCurrent: currentPath ? wt.path === currentPath : false,
		drifted: drift ? isDrifted(wt, drift.repoRoot, drift.rootDir) : false,
	};
}

export function formatWorktreeLine(wt: Worktree, currentPath: string | null, drift: DriftContext | null): string {
	const isCurrent = currentPath ? wt.path === currentPath : false;
	const drifted = drift ? isDrifted(wt, drift.repoRoot, drift.rootDir) : false;

	const icon = isCurrent ? pc.green("◆") : pc.dim("◇");
	const name = isCurrent ? pc.green(wt.branch) : wt.branch;
	const badges = [
		wt.isMain && pc.cyan("(main)"),
		isCurrent && pc.green("(current)"),
		drifted && pc.yellow("⚠ dir≠branch"),
	]
		.filter(Boolean)
		.join(" ");
	const marker = badges ? ` ${badges}` : "";
	const path = pc.dim(`    ${wt.path}`);

	return `${icon} ${name}${marker}\n${path}`;
}

async function resolveDriftContext(container: Container): Promise<DriftContext | null> {
	const { git, fs } = container;
	const rootResult = await git.getMainWorktreeRoot();
	if (Result.isErr(rootResult)) return null;
	const configResult = await loadConfig({ git, fs });
	if (Result.isErr(configResult)) return null;
	return { repoRoot: rootResult.data, rootDir: configResult.data.config.rootDir };
}

async function resolveCurrentPath(git: GitPort): Promise<string | null> {
	const currentRootResult = await git.getRepositoryRoot();
	return Result.isOk(currentRootResult) ? currentRootResult.data : null;
}

export function listCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "list",
			description: "List all worktrees",
		},
		args: {
			json: {
				type: "boolean",
				default: false,
				description: "Output as JSON array",
			},
		},
		async run({ args }) {
			const { ui, git } = container;

			if (args.json) {
				const result = await listWorktrees({ git });

				if (Result.isErr(result)) {
					process.stderr.write(`${JSON.stringify({ error: result.error.message })}\n`);
					process.exit(EXIT_FAILURE);
				}

				const currentPath = await resolveCurrentPath(git);
				const drift = await resolveDriftContext(container);

				const items = result.data.worktrees.map((wt) => toListItem(wt, currentPath, drift));

				process.stdout.write(`${JSON.stringify(items)}\n`);
				return;
			}

			ui.intro("worktree-kit list");

			await runCommand(async () => {
				const result = await listWorktrees({ git });

				if (Result.isErr(result)) {
					throw new CommandError(result.error.message, EXIT_FAILURE);
				}

				if (result.data.worktrees.length === 0) {
					ui.info("No worktrees found");
				} else {
					const currentPath = await resolveCurrentPath(git);
					const drift = await resolveDriftContext(container);

					for (const wt of result.data.worktrees) {
						ui.info(formatWorktreeLine(wt, currentPath, drift));
					}
				}

				ui.outro("Done!");
			}, ui);
		},
	});
}
