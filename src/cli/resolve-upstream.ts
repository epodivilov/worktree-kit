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
const URL_UNAVAILABLE = "URL unavailable";

interface UpstreamCandidate {
	name: string;
	url: string;
}

interface ResolveUpstreamOptions {
	declineLabel: string;
	singleCandidateMessage?: (candidate: UpstreamCandidate) => string;
}

/**
 * Detect candidate upstream remotes (every remote except the primary remote)
 * and, when interactive, prompt the user the same way both `init` and `update`
 * do: a single candidate is offered via `confirm`, several via `select`.
 *
 * Excluding the resolved primary remote — rather than the literal `origin` — is
 * what makes a fork layout work: when the fork is primary, `origin` (the
 * original project) stays offerable; when `origin` is primary, it is excluded.
 *
 * All UI lives here in the CLI layer. The `declineLabel` parametrizes the
 * opt-out option's label so callers can phrase it for their flow, while the
 * single-candidate message lets update describe its immediate side effect.
 */
export async function resolveUpstream(
	git: GitPort,
	ui: UiPort,
	options: ResolveUpstreamOptions,
): Promise<ResolveUpstreamResult> {
	if (ui.nonInteractive) {
		return { kind: "none" };
	}

	const remotesResult = await git.listRemotes();
	const remotes = remotesResult.success ? remotesResult.data : [];
	const primaryRemote = git.getPrimaryRemote();
	const candidates = remotes.filter((r) => r !== primaryRemote);

	if (candidates.length === 0) {
		return { kind: "none" };
	}
	const candidatesWithUrls = await Promise.all(
		candidates.map(async (name): Promise<UpstreamCandidate> => {
			const remoteUrl = await git.getRemoteUrl(name);
			return { name, url: remoteUrl.success ? remoteUrl.data : URL_UNAVAILABLE };
		}),
	);

	if (candidatesWithUrls.length === 1) {
		const candidate = candidatesWithUrls[0] as UpstreamCandidate;
		const confirmed = await ui.confirm({
			message:
				options.singleCandidateMessage?.(candidate) ??
				`Use '${candidate.name}' (fetch URL: ${candidate.url}) as a possible upstream for syncing the default branch?`,
			initialValue: false,
		});
		if (ui.isCancel(confirmed)) {
			ui.cancel("Cancelled");
			process.exit(EXIT_CANCEL);
		}
		return confirmed === true ? { kind: "selected", name: candidate.name } : { kind: "declined" };
	}

	const chosen = await ui.select<string>({
		message: "Which possible upstream should be used for syncing the default branch?",
		options: [
			...candidatesWithUrls.map((candidate) => ({
				value: candidate.name,
				label: `${candidate.name} (fetch URL: ${candidate.url})`,
			})),
			{ value: SKIP, label: options.declineLabel },
		],
	});
	if (ui.isCancel(chosen)) {
		ui.cancel("Cancelled");
		process.exit(EXIT_CANCEL);
	}
	return chosen === SKIP ? { kind: "declined" } : { kind: "selected", name: chosen };
}
