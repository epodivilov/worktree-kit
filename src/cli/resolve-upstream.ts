import type { GitPort } from "../domain/ports/git-port.ts";
import type { UiPort } from "../domain/ports/ui-port.ts";
import { EXIT_CANCEL } from "./exit-codes.ts";

/**
 * Result of detecting and prompting for an upstream remote.
 *
 * - `selected` — the user picked a remote `name`.
 * - `declined` — the user explicitly opted out (single-candidate "no" or
 *   choosing the skip option from the list).
 * - `none` — there were no candidate remotes, or the run is non-interactive.
 */
export type ResolveUpstreamResult = { kind: "selected"; name: string } | { kind: "declined" } | { kind: "none" };

const SKIP = "__skip__";

/**
 * Detect candidate upstream remotes (every remote except `origin`) and, when
 * interactive, prompt the user the same way both `init` and `update` do:
 * a single candidate is offered via `confirm`, several via `select`.
 *
 * All UI lives here in the CLI layer. The `declineLabel` parametrizes the
 * opt-out option's label so callers can phrase it for their flow.
 */
export async function resolveUpstream(
	git: GitPort,
	ui: UiPort,
	options: { declineLabel: string },
): Promise<ResolveUpstreamResult> {
	if (ui.nonInteractive) {
		return { kind: "none" };
	}

	const remotesResult = await git.listRemotes();
	const remotes = remotesResult.success ? remotesResult.data : [];
	const candidates = remotes.filter((r) => r !== "origin");

	if (candidates.length === 0) {
		return { kind: "none" };
	}

	if (candidates.length === 1) {
		const name = candidates[0] as string;
		const confirmed = await ui.confirm({
			message: `Use '${name}' as the upstream remote for syncing the default branch?`,
			initialValue: true,
		});
		if (ui.isCancel(confirmed)) {
			ui.cancel("Cancelled");
			process.exit(EXIT_CANCEL);
		}
		return confirmed === true ? { kind: "selected", name } : { kind: "declined" };
	}

	const chosen = await ui.select<string>({
		message: "Which remote should be used as the upstream for syncing the default branch?",
		options: [
			...candidates.map((name) => ({ value: name, label: name })),
			{ value: SKIP, label: options.declineLabel },
		],
	});
	if (ui.isCancel(chosen)) {
		ui.cancel("Cancelled");
		process.exit(EXIT_CANCEL);
	}
	return chosen === SKIP ? { kind: "declined" } : { kind: "selected", name: chosen };
}
