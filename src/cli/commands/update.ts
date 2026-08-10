import { defineCommand } from "citty";
import pc from "picocolors";
import * as v from "valibot";
import { classifyGoneBranch } from "../../application/use-cases/classify-gone-branch.ts";
import { cleanupWorktrees } from "../../application/use-cases/cleanup-worktrees.ts";
import { loadConfig } from "../../application/use-cases/load-config.ts";
import { setConfigUpstream } from "../../application/use-cases/set-config-upstream.ts";
import {
	type UpdateProgressReporter,
	updateWorktrees,
	type WorktreeReport,
} from "../../application/use-cases/update-worktrees.ts";
import type { MultiSpinnerHandle } from "../../domain/ports/ui-port.ts";
import { UpdateArgsSchema } from "../../domain/schemas/command-args-schema.ts";
import type { Container } from "../../infrastructure/container.ts";
import { formatDisplayPath } from "../../shared/format-path.ts";
import { Result } from "../../shared/result.ts";
import { CleanupHandle } from "../cleanup-handle.ts";
import { EXIT_CANCEL, EXIT_FAILURE } from "../exit-codes.ts";
import { GLOBAL_ARGS } from "../global-args.ts";
import { resolveUpstream } from "../resolve-upstream.ts";
import { CommandError, runCommand } from "../run-command.ts";

/**
 * Maps a per-worktree report to a single terminal spinner line. `complete` (✓) is
 * used for benign outcomes (rebased, would-be-rebased, already-merged skip); `fail`
 * (✗) for conflicts and descendants skipped under a failed parent. Supplementary
 * warnings are surfaced separately after the spinner, not folded in here.
 */
function progressLine(report: WorktreeReport): { terminal: "complete" | "fail"; message: string } {
	const onto = report.parent ?? "the default branch";
	const reparent = report.retargetedFrom ? ` (re-parented from ${report.retargetedFrom})` : "";
	switch (report.result.status) {
		case "rebased":
		case "rebased-dirty": {
			const wip = report.result.status === "rebased-dirty" ? " (via WIP commit)" : "";
			return { terminal: "complete", message: `rebased onto ${onto}${wip}${reparent}` };
		}
		case "dry-run": {
			const wip = report.result.dirty ? " (dirty, via WIP commit)" : "";
			return { terminal: "complete", message: `would be rebased onto ${onto}${wip}${reparent}` };
		}
		case "rebase-conflict":
			return { terminal: "fail", message: `conflict, rebase aborted${reparent}` };
		case "skipped":
			return report.result.reason === "fully merged"
				? { terminal: "complete", message: "skipped: fully merged" }
				: { terminal: "fail", message: `skipped: ${report.result.reason}` };
		case "is-default-branch":
			// The default branch is never a spinner key, so this is unreachable via
			// `settle`; kept for exhaustiveness.
			return { terminal: "complete", message: "up to date" };
	}
}

export function updateCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "update",
			description: "Fetch, fast-forward default branch, and rebase feature branches",
		},
		args: {
			...GLOBAL_ARGS,
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
			jobs: {
				type: "string",
				description: "Max worktrees to rebase concurrently (default 4)",
				required: false,
			},
		},
		async run({ args }) {
			const { ui, git, fs, shell } = container;

			ui.intro("worktree-kit update");

			await runCommand(async () => {
				const parsed = v.parse(UpdateArgsSchema, args);
				const { branch, cleanup: autoCleanup, jobs } = parsed;
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

				// Live per-worktree progress. The multi-spinner is created lazily by the
				// use case's `begin` callback, once the full targeted-worktree set (keys)
				// is known — including children that will be skipped under a failed parent.
				let updateSpinner: MultiSpinnerHandle | undefined;
				const progress: UpdateProgressReporter = {
					begin(branches) {
						updateSpinner = ui.createMultiSpinner(branches);
					},
					rebasing(branchName, onto) {
						updateSpinner?.update(branchName, `rebasing onto ${onto}`);
					},
					settle(report) {
						if (!updateSpinner) return;
						const { terminal, message } = progressLine(report);
						if (terminal === "complete") {
							updateSpinner.complete(report.branch, message);
						} else {
							updateSpinner.fail(report.branch, message);
						}
					},
				};

				const cleanup = new CleanupHandle();
				cleanup.register(async () => {
					const worktrees = await git.listWorktrees();
					if (!worktrees.success) return;
					for (const wt of worktrees.data) {
						const rebasing = await git.isRebaseInProgress(wt.path);
						if (rebasing.success && rebasing.data) {
							const abortResult = await git.rebaseAbort(wt.path);
							if (!abortResult.success) {
								ui.warn(`Failed to abort rebase in "${wt.path}": ${abortResult.error.message}`);
							}
							const msg = await git.getLastCommitMessage(wt.path);
							if (msg.success && msg.data === "WIP") {
								const resetResult = await git.resetLastCommit(wt.path);
								if (!resetResult.success) {
									ui.warn(`Failed to restore WIP commit in "${wt.path}": ${resetResult.error.message}`);
								}
							}
						}
					}
				});

				const needsShell = postUpdateHooks.length > 0 || onConflictHooks.length > 0;
				const result = await updateWorktrees(
					{ dryRun, branch, postUpdateHooks, onConflictHooks, repoRoot, upstream, jobs },
					{ git, shell: needsShell ? shell : undefined, progress },
				);

				cleanup.clear();
				updateSpinner?.stop();

				if (Result.isErr(result)) {
					throw new CommandError(result.error.message, EXIT_FAILURE);
				}

				const { defaultBranch, defaultBranchUpdate, defaultBranchBehind, syncedFromUpstream, reports } = result.data;

				if (defaultBranchUpdate === "would-update") {
					// Dry run: nothing was synced, so preview the advance instead of claiming
					// a completed action. The commit count is best-effort (see the use case).
					if (defaultBranchBehind === undefined) {
						ui.info(`${defaultBranch} would be advanced`);
					} else if (defaultBranchBehind === 0) {
						ui.info(`${defaultBranch} is already up to date`);
					} else {
						const plural = defaultBranchBehind === 1 ? "" : "s";
						ui.info(`${defaultBranch} would be advanced by ${defaultBranchBehind} commit${plural}`);
					}
				} else if (syncedFromUpstream) {
					ui.success(`${defaultBranch} synced from ${syncedFromUpstream}/${defaultBranch}`);
				} else if (defaultBranchUpdate === "ff-updated") {
					ui.success(`${defaultBranch} fast-forwarded`);
				} else {
					ui.success(`${defaultBranch} ref updated`);
				}

				// The primary per-worktree outcome is already shown live in the multi-spinner
				// (one line per worktree). Here we only surface the supplementary warnings
				// that don't fit on that single line, plus the default branch (which has no
				// spinner line of its own).
				for (const report of reports) {
					const hookFailures = report.hookNotifications.filter((n) => n.level === "warn");

					if (report.result.status === "is-default-branch") {
						if (hookFailures.length > 0) {
							const failMsgs = hookFailures.map((n) => n.message).join("; ");
							ui.warn(`${report.branch} post-update hooks — ${failMsgs}`);
						}
						continue;
					}

					if (
						(report.result.status === "rebased" || report.result.status === "rebased-dirty") &&
						report.result.warning
					) {
						ui.warn(`${report.branch}: ${report.result.warning}`);
					}
					if (report.result.status === "rebase-conflict" && report.result.warning) {
						ui.warn(`${report.branch}: ${report.result.warning}`);
					}
					if (hookFailures.length > 0) {
						const failMsgs = hookFailures.map((n) => n.message).join("; ");
						ui.warn(`${report.branch} post-update hooks — ${failMsgs}`);
					}
				}

				const outroMessage = dryRun ? "Dry run — no changes made" : "Done!";

				const goneResult = await git.listGoneBranches();
				const staleBranches = Result.isOk(goneResult) ? goneResult.data.filter((b) => b !== defaultBranch) : [];

				// Branches whose rebase phase proved them fully merged (cherry-pick / squash
				// detection found all commits in defaultBranch). These are positively merged
				// regardless of whether the remote ref still exists, so they're cleanup
				// candidates too.
				const rebaseMerged = reports
					.filter(
						(r) => r.result.status === "skipped" && r.result.reason === "fully merged" && r.branch !== defaultBranch,
					)
					.map((r) => r.branch);

				if (staleBranches.length === 0 && rebaseMerged.length === 0) {
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
				const mergedSet = new Set<string>();
				const kept: string[] = [];
				for (const b of staleBranches) {
					const classification = await classifyGoneBranch(
						{ branch: b, defaultBranch, worktreePath: worktreePathByBranch.get(b) ?? null, force: false },
						{ git },
					);
					if (classification === "merged") mergedSet.add(b);
					else kept.push(b);
				}
				// Rebase-merged branches are positively merged via patch-id / subject+files.
				// Dedupe against the gone-branch set so a branch in both lists appears once.
				for (const b of rebaseMerged) {
					mergedSet.add(b);
				}
				const merged = [...mergedSet];

				const keptMessage = `${kept.length} branch(es) kept (active worktree or unmerged)`;

				if (merged.length === 0) {
					if (kept.length > 0) {
						ui.info(keptMessage);
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
				if (shouldCleanup && kept.length > 0) {
					ui.info(keptMessage);
				}
				if (!shouldCleanup) {
					ui.info("Branches with gone remotes:");
					for (const b of merged) {
						ui.info(`  ${pc.bold(b)}`);
					}
					if (kept.length > 0) {
						ui.info(keptMessage);
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
					{ force: false, dryRun, skipFetch: true, skipOrphans: true, branches: merged },
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
