import type { GitPort } from "../../domain/ports/git-port.ts";

const MAX_BASE_SCAN = 100;

export interface CherryPickFilterResult {
	lastSkippedCommit: string;
	skippedCount: number;
	totalCount: number;
	method: "patch-id" | "subject";
}

export interface FindCherryPickedPrefixDeps {
	git: GitPort;
}

export interface FindCherryPickedPrefixInput {
	base: string;
	feature: string;
}

function buildResult(
	totalCount: number,
	lastSkippedCommit: string | undefined,
	skippedCount: number,
	method: CherryPickFilterResult["method"],
): CherryPickFilterResult | null {
	if (skippedCount === 0 || skippedCount === totalCount) return null;
	if (!lastSkippedCommit) return null;
	return { lastSkippedCommit, skippedCount, totalCount, method };
}

function findPatchIdPrefix(fullCommits: string[], filteredCommits: Set<string>): number {
	let count = 0;
	for (let i = fullCommits.length - 1; i >= 0; i--) {
		const sha = fullCommits[i];
		if (sha === undefined || filteredCommits.has(sha)) break;
		count++;
	}
	return count;
}

async function getCommitFiles(git: GitPort, sha: string): Promise<Set<string> | null> {
	const result = await git.diffTreeFiles(sha);
	if (!result.success) return null;
	return new Set(result.data);
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const item of a) {
		if (!b.has(item)) return false;
	}
	return true;
}

export async function findCherryPickedPrefix(
	deps: FindCherryPickedPrefixDeps,
	input: FindCherryPickedPrefixInput,
): Promise<CherryPickFilterResult | null> {
	const { git } = deps;
	const { base, feature } = input;

	const fullResult = await git.revList({ range: `${base}..${feature}` });
	if (!fullResult.success) return null;
	const fullCommits = fullResult.data;
	if (fullCommits.length === 0) return null;

	const filteredResult = await git.revListCherryPick({ base, feature });
	if (!filteredResult.success) return null;
	const filteredCommits = new Set(filteredResult.data);

	if (filteredCommits.size < fullCommits.length) {
		const patchIdPrefix = findPatchIdPrefix(fullCommits, filteredCommits);
		const lastSkipped = patchIdPrefix > 0 ? fullCommits[fullCommits.length - patchIdPrefix] : undefined;
		const result = buildResult(fullCommits.length, lastSkipped, patchIdPrefix, "patch-id");
		if (result) return result;
	}

	const featureLogResult = await git.logSubjects(`${base}..${feature}`);
	if (!featureLogResult.success) return null;
	const baseLogResult = await git.logSubjects(`${feature}..${base}`, MAX_BASE_SCAN);
	if (!baseLogResult.success) return null;

	const featureLog = featureLogResult.data;
	const baseLog = baseLogResult.data;

	const baseBySubject = new Map<string, { sha: string; subject: string }[]>();
	for (const entry of baseLog) {
		const list = baseBySubject.get(entry.subject);
		if (list) list.push(entry);
		else baseBySubject.set(entry.subject, [entry]);
	}

	let subjectPrefix = 0;
	for (let i = featureLog.length - 1; i >= 0; i--) {
		const featureEntry = featureLog[i];
		if (!featureEntry) break;
		const candidates = baseBySubject.get(featureEntry.subject);
		if (!candidates) break;

		const featureFiles = await getCommitFiles(git, featureEntry.sha);
		if (!featureFiles) return null;

		let filesMatch = false;
		for (const candidate of candidates) {
			const baseFiles = await getCommitFiles(git, candidate.sha);
			if (!baseFiles) return null;
			if (setsEqual(featureFiles, baseFiles)) {
				filesMatch = true;
				break;
			}
		}

		if (!filesMatch) break;
		subjectPrefix++;
	}

	const lastSkippedEntry = subjectPrefix > 0 ? featureLog[featureLog.length - subjectPrefix] : undefined;
	return buildResult(featureLog.length, lastSkippedEntry?.sha, subjectPrefix, "subject");
}
