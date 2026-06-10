import { defineCommand } from "citty";
import { initConfig, type UpstreamDecision } from "../../application/use-cases/init-config.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { UiPort } from "../../domain/ports/ui-port.ts";
import type { Container } from "../../infrastructure/container.ts";
import { Result } from "../../shared/result.ts";
import { EXIT_CANCEL, EXIT_FAILURE } from "../exit-codes.ts";
import { resolveUpstream as detectUpstream } from "../resolve-upstream.ts";
import { CommandError, runCommand } from "../run-command.ts";

const UPSTREAM_REMOTE_NAME = "upstream";

/**
 * Resolve which git remote should be recorded as the upstream, prompting the
 * user when appropriate. All UI lives here in the CLI layer; the use case only
 * receives the resolved decision.
 */
async function resolveUpstream(
	args: { upstream?: string; force: boolean },
	git: GitPort,
	ui: UiPort,
): Promise<UpstreamDecision | undefined> {
	const remotesResult = await git.listRemotes();
	const remotes = remotesResult.success ? remotesResult.data : [];

	// A. An explicit URL was provided.
	if (args.upstream) {
		const url = args.upstream;
		if (!remotes.includes(UPSTREAM_REMOTE_NAME)) {
			return { name: UPSTREAM_REMOTE_NAME, remote: { action: "add", url } };
		}

		const currentResult = await git.getRemoteUrl(UPSTREAM_REMOTE_NAME);
		const currentUrl = currentResult.success ? currentResult.data : undefined;

		if (currentUrl === url) {
			// Same URL — nothing to change.
			return { name: UPSTREAM_REMOTE_NAME };
		}

		if (ui.nonInteractive) {
			if (args.force) {
				return { name: UPSTREAM_REMOTE_NAME, remote: { action: "set-url", url } };
			}
			ui.warn(
				`Remote '${UPSTREAM_REMOTE_NAME}' already points to ${currentUrl ?? "another URL"}; ignored ${url}. Run 'wt init --force' to overwrite.`,
			);
			return { name: UPSTREAM_REMOTE_NAME };
		}

		const overwrite = await ui.confirm({
			message: `Remote '${UPSTREAM_REMOTE_NAME}' already points to ${currentUrl ?? "another URL"}. Overwrite with ${url}?`,
			initialValue: false,
		});
		if (ui.isCancel(overwrite)) {
			ui.cancel("Cancelled");
			process.exit(EXIT_CANCEL);
		}
		if (overwrite === true) {
			return { name: UPSTREAM_REMOTE_NAME, remote: { action: "set-url", url } };
		}
		return { name: UPSTREAM_REMOTE_NAME };
	}

	// B. No URL flag — detect existing remotes (interactive only). init records
	// nothing on decline/none, and never persists an opt-out.
	const detected = await detectUpstream(git, ui, { declineLabel: "Don't configure" });
	return detected.kind === "selected" ? { name: detected.name } : undefined;
}

export function initCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "init",
			description: "Create .worktreekit.jsonc config",
		},
		args: {
			force: {
				type: "boolean",
				alias: "f",
				description: "Overwrite existing config",
				default: false,
			},
			migrate: {
				type: "boolean",
				alias: "m",
				description: "Rename legacy .worktreekitrc to .worktreekit.jsonc",
				default: false,
			},
			local: {
				type: "boolean",
				alias: "l",
				description: "Create .worktreekit.local.jsonc instead",
				default: false,
			},
			upstream: {
				type: "string",
				description:
					"Git URL of the original repo for fork workflows (adds/updates the 'upstream' remote and records it in config)",
			},
		},
		async run({ args }) {
			const { ui, fs, git } = container;

			ui.intro("worktree-kit init");

			await runCommand(async () => {
				const upstream = args.migrate
					? undefined
					: await resolveUpstream({ upstream: args.upstream, force: args.force }, git, ui);

				const result = await initConfig(
					{ force: args.force, migrate: args.migrate, local: args.local, upstream },
					{ fs, git },
				);

				if (Result.isErr(result)) {
					throw new CommandError(result.error.message, EXIT_FAILURE);
				}

				for (const warning of result.data.warnings) {
					ui.warn(warning);
				}
				const action = args.migrate ? "Migrated config to" : "Created config at";
				ui.success(`${action}: ${result.data.configPath}`);
				ui.outro("Done!");
			}, ui);
		},
	});
}
