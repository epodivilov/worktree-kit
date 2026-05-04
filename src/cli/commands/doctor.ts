import { defineCommand } from "citty";
import pc from "picocolors";
import { runHealthCheck } from "../../application/use-cases/run-health-check.ts";
import type { HealthIssue, HealthSeverity } from "../../domain/entities/health-check.ts";
import type { Container } from "../../infrastructure/container.ts";
import { formatDisplayPath } from "../../shared/format-path.ts";
import { Result } from "../../shared/result.ts";
import { EXIT_FAILURE, EXIT_PARTIAL, EXIT_SUCCESS } from "../exit-codes.ts";
import { CommandError, runCommand } from "../run-command.ts";

const SEVERITY_ORDER: HealthSeverity[] = ["error", "warning", "info"];

const SEVERITY_LABEL: Record<HealthSeverity, string> = {
	error: "Errors",
	warning: "Warnings",
	info: "Info",
};

const SEVERITY_COLOR: Record<HealthSeverity, (s: string) => string> = {
	error: pc.red,
	warning: pc.yellow,
	info: pc.cyan,
};

function describeIssue(issue: HealthIssue, repoRoot: string): string {
	const dp = (p: string) => (repoRoot ? formatDisplayPath(p, repoRoot) : p);
	switch (issue.type) {
		case "broken-symlink":
			return `broken symlink            ${dp(issue.path)}`;
		case "rebase-in-progress":
			return `rebase in progress        ${issue.branch || dp(issue.worktreePath)}`;
		case "merge-in-progress":
			return `merge in progress         ${issue.branch || dp(issue.worktreePath)}`;
		case "config-ref-missing":
			return `config ref missing        ${issue.path} ${pc.dim(`(${issue.field})`)}`;
		case "missing-worktree-directory":
			return `missing worktree directory  ${issue.branch || dp(issue.worktreePath)} ${pc.dim(`(${dp(issue.worktreePath)})`)}`;
		case "empty-prefix-directory":
			return `empty prefix directory    ${dp(issue.path)}`;
		case "dirty-worktree":
			return `dirty worktree            ${issue.branch || dp(issue.worktreePath)}`;
	}
}

function groupBySeverity(issues: readonly HealthIssue[]): Record<HealthSeverity, HealthIssue[]> {
	const groups: Record<HealthSeverity, HealthIssue[]> = { error: [], warning: [], info: [] };
	for (const issue of issues) {
		groups[issue.severity].push(issue);
	}
	return groups;
}

function summaryLine(counts: Record<HealthSeverity, number>, verbose: boolean): string {
	const parts: string[] = [];
	parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`);
	parts.push(`${counts.warning} warning${counts.warning === 1 ? "" : "s"}`);
	if (verbose) {
		parts.push(`${counts.info} info`);
	}
	return parts.join(", ");
}

export function doctorCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "doctor",
			description: "Run a health check across the repository worktrees",
		},
		args: {
			json: {
				type: "boolean",
				default: false,
				description: "Output report as JSON",
			},
			verbose: {
				type: "boolean",
				default: false,
				description: "Include info-level findings in the output",
			},
		},
		async run({ args }) {
			const { ui, git, fs } = container;

			if (args.json) {
				const result = await runHealthCheck({ git, fs });
				if (Result.isErr(result)) {
					process.stderr.write(`${JSON.stringify({ error: result.error.message })}\n`);
					process.exit(EXIT_FAILURE);
				}
				process.stdout.write(`${JSON.stringify(result.data)}\n`);
				const hasProblems = result.data.issues.some((i) => i.severity === "error" || i.severity === "warning");
				process.exit(hasProblems ? EXIT_PARTIAL : EXIT_SUCCESS);
			}

			ui.intro("worktree-kit doctor");

			await runCommand(async () => {
				const result = await runHealthCheck({ git, fs });
				if (Result.isErr(result)) {
					throw new CommandError(result.error.message, EXIT_FAILURE);
				}

				const { issues } = result.data;
				const groups = groupBySeverity(issues);
				const counts = {
					error: groups.error.length,
					warning: groups.warning.length,
					info: groups.info.length,
				};
				const verbose = Boolean(args.verbose);

				const mainRootResult = await git.getMainWorktreeRoot();
				const repoRoot = Result.isOk(mainRootResult) ? mainRootResult.data : "";

				const visibleSeverities: HealthSeverity[] = verbose
					? SEVERITY_ORDER
					: SEVERITY_ORDER.filter((s) => s !== "info");

				let printedAny = false;
				for (const severity of visibleSeverities) {
					const group = groups[severity];
					if (group.length === 0) continue;
					ui.info(SEVERITY_COLOR[severity](pc.bold(SEVERITY_LABEL[severity])));
					for (const issue of group) {
						ui.info(`  ${SEVERITY_COLOR[severity]("•")} ${describeIssue(issue, repoRoot)}`);
					}
					printedAny = true;
				}

				const hasProblems = counts.error > 0 || counts.warning > 0;

				if (!hasProblems && !printedAny) {
					ui.success("No problems found");
					ui.outro("Done!");
					return;
				}

				const summary = summaryLine(counts, verbose);
				if (hasProblems) {
					ui.outro(counts.error > 0 ? pc.red(summary) : pc.yellow(summary));
					process.exit(EXIT_PARTIAL);
				}

				ui.outro(summary);
			}, ui);
		},
	});
}
