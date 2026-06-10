import { defineCommand } from "citty";
import pc from "picocolors";
import * as v from "valibot";
import { classifyGoneBranch } from "../../application/use-cases/classify-gone-branch.ts";
import { cleanupWorktrees } from "../../application/use-cases/cleanup-worktrees.ts";
import { loadConfig } from "../../application/use-cases/load-config.ts";
import { setConfigUpstream } from "../../application/use-cases/set-config-upstream.ts";
import { updateWorktrees } from "../../application/use-cases/update-worktrees.ts";
import { UpdateArgsSchema } from "../../domain/schemas/command-args-schema.ts";
import type { Container } from "../../infrastructure/container.ts";
import { formatDisplayPath } from "../../shared/format-path.ts";
import { Result } from "../../shared/result.ts";
import { CleanupHandle } from "../cleanup-handle.ts";
import { EXIT_CANCEL, EXIT_FAILURE } from "../exit-codes.ts";
import { resolveUpstream } from "../resolve-upstream.ts";
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
				const configuredUpstream = configResult.success ? configResult.data.config.upstream : undefined;

				let repoRoot = "";
				if (postUpdateHooks.length > 0 || onConflictHooks.length > 0) {
					const rootResult = await git.getRepositoryRoot();
					if (rootResult.success) {
						repoRoot = rootResult.data;
					}
				}

				// Resolve the upstream remote to sync the default branch from.
				// - `false` → explicit opt-out, never sync and never ask.
				// - non-empty string → use it (configured).
				// - undefined → eligible for auto-detection (interactive, non-dry-run only).
				let upstream: string | undefined = typeof configuredUpstream === "string" ? configuredUpstream : undefined;

				if (configResult.success && configuredUpstream === undefined && !ui.nonInteractive && !dryRun) {
					const detected = await resolveUpstream(git, ui, { declineLabel: "Skip and don't ask again" });
					const { configPath, isLegacyConfig } = configResult.data;

					const persist = async (value: string | false): Promise<void> => {
						if (isLegacyConfig) {
							ui.warn(
								`Legacy config ${configPath} cannot be updated automatically. Run 'wt init --migrate', then re-run 'wt update' to save the upstream choice.`,
							);
							return;
						}
						const setResult = await setConfigUpstream({ configPath, value }, { fs });
						if (Result.isErr(setResult)) {
							ui.warn(`Could not save upstream choice: ${setResult.error.message}`);
						}
					};

					if (detected.kind === "selected") {
						upstream = detected.name;
						await persist(detected.name);
					} else if (detected.kind === "declined") {
						await persist(false);
					}
				}

				const spinner = ui.createSpinner();
				spinner.start("Fetching and updating worktrees...");

				const cleanup = new CleanupHandle();
				cleanup.register(async () => {
					const worktrees = await git.listWorktrees();
					if (!worktrees.success) return;
					for (const wt of worktrees.data) {
						const rebasing = await git.isRebaseInProgress(wt.path);
						if (rebasing.success && rebasing.data) {
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
					{ dryRun, branch, postUpdateHooks, onConflictHooks, repoRoot, upstream },
					{ git, shell: needsShell ? shell : undefined },
				);

				cleanup.clear();

				if (Result.isErr(result)) {
					spinner.stop(pc.red("Failed"));
					throw new CommandError(result.error.message, EXIT_FAILURE);
				}

				spinner.stop(pc.green("Done"));

				const { defaultBranch, defaultBranchUpdate, syncedFromUpstream, reports } = result.data;

				if (syncedFromUpstream) {
					ui.success(`${defaultBranch} synced from ${syncedFromUpstream}/${defaultBranch}`);
				} else if (defaultBranchUpdate === "ff-updated") {
					ui.success(`${defaultBranch} fast-forwarded`);
				} else {
					ui.success(`${defaultBranch} ref updated`);
				}

				for (const report of reports) {
					const onto = report.parent ?? defaultBranch;
					const hookFailures = report.hookNotifications.filter((n) => n.level === "warn");

					switch (report.result.status) {
						case "is-default-branch":
							if (hookFailures.length > 0) {
								const failMsgs = hookFailures.map((n) => n.message).join("; ");
								ui.warn(`${report.branch} post-update hooks — ${failMsgs}`);
							}
							break;
						case "rebased":
						case "rebased-dirty": {
							const wip = report.result.status === "rebased-dirty" ? " (via WIP commit)" : "";
							const reparent = report.retargetedFrom ? ` (re-parented from ${report.retargetedFrom})` : "";
							const suffix = `${wip}${reparent}`;
							if (hookFailures.length > 0) {
								const failMsgs = hookFailures.map((n) => n.message).join("; ");
								ui.warn(`${report.branch} rebased onto ${onto}${suffix} — ${failMsgs}`);
							} else {
								ui.success(`${report.branch} rebased onto ${onto}${suffix}`);
							}
							break;
						}
						case "rebase-conflict": {
							const reparent = report.retargetedFrom ? ` (re-parented from ${report.retargetedFrom})` : "";
							ui.warn(`${report.branch} has conflicts, rebase aborted${reparent}`);
							break;
						}
						case "dry-run": {
							const wip = report.result.dirty ? " (dirty, via WIP commit)" : "";
							const reparent = report.retargetedFrom ? ` (re-parented from ${report.retargetedFrom})` : "";
							ui.info(`${report.branch} would be rebased onto ${onto}${wip}${reparent}`);
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

				// Pre-classify so we don't prompt the user about branches that would
				// just be kept (active worktree + uncommitted work, or unmerged).
				const worktreesForClassify = await git.listWorktrees();
				const worktreePathByBranch = new Map<string, string | null>();
				if (Result.isOk(worktreesForClassify)) {
					for (const wt of worktreesForClassify.data) {
						if (wt.branch) worktreePathByBranch.set(wt.branch, wt.path);
					}
				}

				// Only prompt for branches with positive proof of merge.
				// "empty" (ahead=0 without merge proof) and unmerged/dirty are kept.
				const merged: string[] = [];
				const kept: string[] = [];
				for (const b of staleBranches) {
					const classification = await classifyGoneBranch(
						{ branch: b, defaultBranch, worktreePath: worktreePathByBranch.get(b) ?? null, force: false },
						{ git },
					);
					if (classification === "merged") merged.push(b);
					else kept.push(b);
				}

				if (merged.length === 0) {
					if (kept.length > 0) {
						ui.info(`${kept.length} branch(es) kept (active worktree or unmerged)`);
					}
					ui.outro(outroMessage);
					return;
				}

				if (ui.nonInteractive && !autoCleanup) {
					ui.warn(`${merged.length} branch(es) have gone remotes, run 'wt cleanup'`);
					ui.outro(outroMessage);
					return;
				}

				let shouldCleanup = autoCleanup;
				if (!shouldCleanup) {
					ui.info("Branches with gone remotes:");
					for (const b of merged) {
						ui.info(`  ${pc.bold(b)}`);
					}
					if (kept.length > 0) {
						ui.info(`${kept.length} branch(es) kept (active worktree or unmerged)`);
					}
					const confirmed = await ui.confirm({
						message: `Clean up ${merged.length} stale branch(es)?`,
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
							ui.warn(
								`${cleanupReport.branch} — skipped: uncommitted changes in ${dp(cleanupReport.worktreePath)}. Commit or stash them, then run 'wt cleanup' (or 'wt cleanup --force' to discard).`,
							);
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
							ui.warn(
								`${name} — orphaned worktree skipped (${reason}, uncommitted changes). Commit or stash them, then run 'wt cleanup' (or 'wt cleanup --force' to discard).`,
							);
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
