import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { GitError, GitPort } from "../domain/ports/git-port.ts";
import { createBunGitAdapter } from "../infrastructure/adapters/bun-git-adapter.ts";
import type { Result } from "../shared/result.ts";
import { createFakeGit } from "./fake-git.ts";
import { createRemoteFixture } from "./git-fixtures.ts";
import { createNoopLogger } from "./noop-logger.ts";
import { createTempDir } from "./temp-dir.ts";

// Contract suite: for the same repository state, the fake and the real
// adapter must produce the same outcome — success or error code. The real
// adapter is the source of truth; when the two diverge, fix the fake.
//
// Canonical state every session provides:
//   - branch "merged"      exists locally, fully merged into main
//   - branch "unmerged"    exists locally with its own commit
//   - remote ref "remote-feat" exists on origin
//   - "ghost" exists neither locally nor on the remote

interface GitPortSession extends AsyncDisposable {
	readonly git: GitPort;
}

async function openFakeSession(): Promise<GitPortSession> {
	const git = createFakeGit({
		branches: ["main", "merged", "unmerged"],
		mergedBranches: ["merged"],
		remoteBranches: ["main", "remote-feat"],
	});
	return { git, async [Symbol.asyncDispose]() {} };
}

async function openRealSession(): Promise<GitPortSession> {
	const tmp = await createTempDir();
	const fixture = await createRemoteFixture(tmp.path);
	const repo = fixture.repoPath;

	await Bun.$`git -C ${repo} branch merged`.quiet();

	await Bun.$`git -C ${repo} checkout -q -b unmerged`.quiet();
	await Bun.write(join(repo, "unmerged.txt"), "unmerged work");
	await Bun.$`git -C ${repo} add .`.quiet();
	await Bun.$`git -C ${repo} commit -m "unmerged work"`.quiet();
	await Bun.$`git -C ${repo} checkout -q main`.quiet();

	await fixture.addTrackedBranch("remote-feat");

	const originalCwd = process.cwd();
	process.chdir(repo);
	return {
		git: createBunGitAdapter(createNoopLogger(), "origin"),
		async [Symbol.asyncDispose]() {
			process.chdir(originalCwd);
			await tmp[Symbol.asyncDispose]();
		},
	};
}

type Outcome = { ok: true } | { ok: false; code: GitError["code"] };

interface ContractCase {
	name: string;
	run(git: GitPort): Promise<Result<unknown, GitError>>;
	expected: Outcome;
}

const CASES: ContractCase[] = [
	{
		name: "deleteBranch on a merged branch succeeds",
		run: (git) => git.deleteBranch("merged"),
		expected: { ok: true },
	},
	{
		name: "deleteBranch on an unmerged branch fails with BRANCH_NOT_MERGED",
		run: (git) => git.deleteBranch("unmerged"),
		expected: { ok: false, code: "BRANCH_NOT_MERGED" },
	},
	{
		name: "deleteBranch on a missing branch fails with BRANCH_NOT_FOUND",
		run: (git) => git.deleteBranch("ghost"),
		expected: { ok: false, code: "BRANCH_NOT_FOUND" },
	},
	{
		name: "deleteBranchForce on an unmerged branch succeeds",
		run: (git) => git.deleteBranchForce("unmerged"),
		expected: { ok: true },
	},
	{
		name: "deleteBranchForce on a missing branch fails with BRANCH_NOT_FOUND",
		run: (git) => git.deleteBranchForce("ghost"),
		expected: { ok: false, code: "BRANCH_NOT_FOUND" },
	},
	{
		name: "deleteRemoteBranch on an existing remote ref succeeds",
		run: (git) => git.deleteRemoteBranch("remote-feat"),
		expected: { ok: true },
	},
	{
		name: "deleteRemoteBranch on a missing remote ref fails with REMOTE_REF_NOT_FOUND",
		run: (git) => git.deleteRemoteBranch("ghost"),
		expected: { ok: false, code: "REMOTE_REF_NOT_FOUND" },
	},
];

const IMPLEMENTATIONS = [
	{ label: "fake-git", open: openFakeSession },
	{ label: "bun-git-adapter (real git)", open: openRealSession },
];

for (const impl of IMPLEMENTATIONS) {
	describe(`GitPort contract — ${impl.label}`, () => {
		for (const contractCase of CASES) {
			test(contractCase.name, async () => {
				await using session = await impl.open();
				const result = await contractCase.run(session.git);

				if (contractCase.expected.ok) {
					expect(result).toMatchObject({ success: true });
				} else {
					expect(result.success).toBe(false);
					if (!result.success) {
						expect(result.error.code).toBe(contractCase.expected.code);
					}
				}
			});
		}
	});
}
