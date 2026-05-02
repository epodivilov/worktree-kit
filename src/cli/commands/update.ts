import { defineCommand } from "citty";
import pc from "picocolors";
import * as v from "valibot";
import { cleanupWorktrees } from "../../application/use-cases/cleanup-worktrees.ts";
import { loadConfig } from "../../application/use-cases/load-config.ts";
import { updateWorktrees } from "../../application/use-cases/update-worktrees.ts";
import { UpdateArgsSchema } from "../../domain/schemas/command-args-schema.ts";
import type { Container } from "../../infrastructure/container.ts";
import { formatDisplayPath } from "../../shared/format-path.ts";
import { Result } from "../../shared/result.ts";
import { CleanupHandle } from "../cleanup-handle.ts";
import { EXIT_CANCEL, EXIT_FAILURE } from "../exit-codes.ts";
import { CommandError, runCommand } from "../run-command.ts";

export function updateCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "update",
			description: "Fetch, fast-forward default branch, and rebase feature branches",
		},
		args: {
			branch: {
				type: "positional",
				description: "Branch to update (with its sub-branches). Updates all if omitted",
				required: false,
			},
			"dry-run": {
				type: "boolean",
				description: "Show what would be done without making changes",
				required: false,
			},
			cleanup: {
				type: "boolean",
				description: "Automatically clean up branches with gone remotes after update",
				required: false,
			},
		},
		async run({ args }) {
			const { ui, git, fs, shell } = container;

			ui.intro("worktree-kit update");

			await runCommand(async () => {
				const parsed = v.parse(UpdateArgsSchema, args);
				const { branch, cleanup: autoCleanup } = parsed;
				const dryRun = parsed["dry-run"];
				const configResult = await loadConfig({ git, fs });
				const postUpdateHooks = configResult.success ? configResult.data.config.hooks["post-update"] : [];
				const onConflictHooks = configResult.success ? configResult.data.config.hooks["on-conflict"] : [];

				let repoRoot = "";
				if (postUpdateHooks.length > 0 || onConflictHooks.length > 0) {
					const rootResult = await git.getRepositoryRoot();
					if (rootResult.success) {
						repoRoot = rootResult.data;
					}
				}

				const spinner = ui.createSpinner();
				spinner.start("Fetching and updating worktrees...");

				const cleanup = new CleanupHandle();
				cleanup.register(async () => {
					const worktrees = await git.listWorktrees();
					if (!worktrees.success) return;
					for (const wt of worktrees.data) {
						if (await git.isRebaseInProgress(wt.path)) {
							await git.rebaseAbort(wt.path);
							const msg = await git.getLastCommitMessage(wt.path);
							if (msg.success && msg.data === "WIP") {
								await git.resetLastCommit(wt.path);
							}
						}
					}
				});

				const needsShell = postUpdateHooks.length > 0 || onConflictHooks.length > 0;
				const result = await updateWorktrees(
					{ dryRun, branch, postUpdateHooks, onConflictHooks, repoRoot },
					{ git, shell: needsShell ? shell : undefined },
				);

				cleanup.clear();

				if (Result.isErr(result)) {
					spinner.stop(pc.red("Failed"));
					throw new CommandError(result.error.message, EXIT_FAILURE);
				}

				spinner.stop(pc.green("Done"));

				const { defaultBranch, defaultBranchUpdate, reports } = result.data;

				if (defaultBranchUpdate === "ff-updated") {
					ui.success(`${defaultBranch} fast-forwarded`);
				} else {
					ui.success(`${defaultBranch} ref updated`);
				}

				for (const report of reports) {
					const onto = report.parent ?? defaultBranch;
					const hookFailures = report.hookNotifications.filter((n) => n.level === "warn");

					switch (report.result.status) {
						case "is-default-branch":
							break;
						case "rebased":
						case "rebased-dirty": {
							const suffix = report.result.status === "rebased-dirty" ? " (via WIP commit)" : "";
							if (hookFailures.length > 0) {
								const failMsgs = hookFailures.map((n) => n.message).join("; ");
								ui.warn(`${report.branch} rebased onto ${onto}${suffix} — ${failMsgs}`);
							} else {
								ui.success(`${report.branch} rebased onto ${onto}${suffix}`);
							}
							break;
						}
						case "rebase-conflict":
							ui.warn(`${report.branch} has conflicts, rebase aborted`);
							break;
						case "dry-run": {
							const suffix = report.result.dirty ? " (dirty, via WIP commit)" : "";
							ui.info(`${report.branch} would be rebased onto ${onto}${suffix}`);
							break;
						}
						case "skipped":
							ui.warn(`${report.branch} skipped: ${report.result.reason}`);
							break;
					}
				}

				const outroMessage = dryRun ? "Dry run — no changes made" : "Done!";

				const goneResult = await git.listGoneBranches();
				const staleBranches = Result.isOk(goneResult) ? goneResult.data.filter((b) => b !== defaultBranch) : [];

				if (staleBranches.length === 0) {
					ui.outro(outroMessage);
					return;
				}

				if (ui.nonInteractive && !autoCleanup) {
					ui.warn(`${staleBranches.length} branch(es) have gone remotes, run 'wt cleanup'`);
					ui.outro(outroMessage);
					return;
				}

				let shouldCleanup = autoCleanup;
				if (!shouldCleanup) {
					ui.info("Branches with gone remotes:");
					for (const b of staleBranches) {
						ui.info(`  ${pc.bold(b)}`);
					}
					const confirmed = await ui.confirm({
						message: `Clean up ${staleBranches.length} stale branch(es)?`,
						initialValue: false,
					});
					if (ui.isCancel(confirmed)) {
						ui.cancel("Cleanup cancelled");
						process.exit(EXIT_CANCEL);
					}
					shouldCleanup = confirmed === true;
				}

				if (!shouldCleanup) {
					ui.outro(outroMessage);
					return;
				}

				const cleanupSpinner = ui.createSpinner();
				cleanupSpinner.start("Cleaning up stale branches...");

				const cleanupResult = await cleanupWorktrees(
					{ force: false, dryRun, skipFetch: true, skipOrphans: true },
					{ git },
				);

				if (Result.isErr(cleanupResult)) {
					cleanupSpinner.stop(pc.red("Failed"));
					throw new CommandError(cleanupResult.error.message, EXIT_FAILURE);
				}

				cleanupSpinner.stop(pc.green("Cleanup complete"));

				const mainRootResult = await git.getMainWorktreeRoot();
				const cleanupRepoRoot = Result.isOk(mainRootResult) ? mainRootResult.data : "";
				const dp = (p: string | null) =>
					p && cleanupRepoRoot ? formatDisplayPath(p, cleanupRepoRoot) : (p ?? "(unknown)");

				for (const cleanupReport of cleanupResult.data.reports) {
					switch (cleanupReport.result.status) {
						case "cleaned":
							ui.success(`${cleanupReport.branch} — worktree and branch removed`);
							break;
						case "branch-only":
							ui.success(`${cleanupReport.branch} — branch removed (no matching worktree found)`);
							break;
						case "skipped-unmerged":
							ui.warn(`${cleanupReport.branch} — skipped (not fully merged, use 'wt cleanup --force')`);
							break;
						case "skipped-dirty":
							ui.warn(`${cleanupReport.branch} — skipped (worktree has uncommitted changes)`);
							break;
						case "dry-run": {
							const name = cleanupReport.branch || dp(cleanupReport.worktreePath);
							ui.info(`${name} — would be cleaned up`);
							break;
						}
						case "orphan-cleaned": {
							const reason = cleanupReport.branch ? "branch does not exist" : "detached HEAD";
							const name = cleanupReport.branch || dp(cleanupReport.worktreePath);
							ui.success(`${name} — orphaned worktree removed (${reason})`);
							break;
						}
						case "orphan-skipped-dirty": {
							const reason = cleanupReport.branch ? "branch does not exist" : "detached HEAD";
							const name = cleanupReport.branch || dp(cleanupReport.worktreePath);
							ui.warn(`${name} — orphaned worktree skipped (${reason}, uncommitted changes)`);
							break;
						}
						case "orphan-dry-run": {
							const name = cleanupReport.branch || dp(cleanupReport.worktreePath);
							ui.info(`${name} — orphaned worktree would be removed`);
							break;
						}
						case "error":
							ui.error(`${cleanupReport.branch} — ${cleanupReport.result.message}`);
							break;
					}
				}

				ui.outro(outroMessage);
			}, ui);
		},
	});
}
