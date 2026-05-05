import type { GitPort } from "../../domain/ports/git-port.ts";

const MAX_BASE_SCAN = 100;

export interface SquashMergeFilterResult {
	lastSkippedCommit: string;
	skippedCount: number;
	totalCount: number;
	method: "squash";
}

export interface FindSquashMergedPrefixDeps {
	git: GitPort;
}

export interface FindSquashMergedPrefixInput {
	base: string;
	feature: string;
}

function fileSetFingerprint(files: Set<string>): string {
	return [...files].sort().join("\0");
}

async function getCommitFiles(git: GitPort, sha: string): Promise<Set<string> | null> {
	const result = await git.diffTreeFiles(sha);
	if (!result.success) return null;
	return new Set(result.data);
}

export async function findSquashMergedPrefix(
	deps: FindSquashMergedPrefixDeps,
	input: FindSquashMergedPrefixInput,
): Promise<SquashMergeFilterResult | null> {
	const { git } = deps;
	const { base, feature } = input;

	const featureResult = await git.revList({ range: `${base}..${feature}` });
	if (!featureResult.success) return null;
	const featureCommits = [...featureResult.data].reverse();
	if (featureCommits.length === 0) return null;

	const mergeBaseResult = await git.getMergeBase(base, feature);
	if (!mergeBaseResult.success) return null;
	const mergeBase = mergeBaseResult.data;

	const prefixByFingerprint = new Map<string, number[]>();
	const cumulativeFiles = new Set<string>();
	for (let i = 0; i < featureCommits.length; i++) {
		const sha = featureCommits[i];
		if (!sha) continue;
		const files = await getCommitFiles(git, sha);
		if (!files) return null;
		for (const f of files) cumulativeFiles.add(f);
		const fp = fileSetFingerprint(cumulativeFiles);
		const existing = prefixByFingerprint.get(fp);
		if (existing) existing.push(i + 1);
		else prefixByFingerprint.set(fp, [i + 1]);
	}

	const candidatesResult = await git.revList({ range: `${feature}..${base}` });
	if (!candidatesResult.success) return null;
	const candidates = candidatesResult.data.slice(0, MAX_BASE_SCAN);

	for (const candidate of candidates) {
		const candidateFiles = await getCommitFiles(git, candidate);
		if (!candidateFiles) continue;
		const fp = fileSetFingerprint(candidateFiles);
		const matchingPrefixes = prefixByFingerprint.get(fp);
		if (!matchingPrefixes) continue;

		const squashDiffResult = await git.diffNormalized({ from: `${candidate}^`, to: candidate });
		if (!squashDiffResult.success) continue;
		if (squashDiffResult.data === "") continue;

		for (let i = matchingPrefixes.length - 1; i >= 0; i--) {
			const prefixLength = matchingPrefixes[i];
			if (prefixLength === undefined) continue;
			if (prefixLength === featureCommits.length) continue;
			const lastPrefixCommit = featureCommits[prefixLength - 1];
			if (!lastPrefixCommit) continue;

			const prefixDiffResult = await git.diffNormalized({ from: mergeBase, to: lastPrefixCommit });
			if (!prefixDiffResult.success) continue;

			if (prefixDiffResult.data === squashDiffResult.data) {
				return {
					lastSkippedCommit: lastPrefixCommit,
					skippedCount: prefixLength,
					totalCount: featureCommits.length,
					method: "squash",
				};
			}
			// TODO: near-miss telemetry
		}
	}

	return null;
}
