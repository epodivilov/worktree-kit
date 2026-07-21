import { describe, expect, test } from "bun:test";
import { createBunGitAdapter } from "../infrastructure/adapters/bun-git-adapter.ts";
import { expectErr, expectOk } from "./assertions.ts";
import { createRemoteFixture, initUnbornRepo } from "./git-fixtures.ts";
import { createNoopLogger } from "./noop-logger.ts";
import { createTempDir } from "./temp-dir.ts";

// Self-tests: prove the fixtures produce the git states the adapter
// integration tests (and the fake-vs-adapter contract suite) depend on.
describe("git fixtures", () => {
	const git = createBunGitAdapter(createNoopLogger(), "origin");

	test("remote fixture supports the full gone-branch flow", async () => {
		await using tmp = await createTempDir();
		const fixture = await createRemoteFixture(tmp.path);
		await fixture.addTrackedBranch("feat", { withCommit: true });
		await fixture.deleteRemoteBranch("feat");

		const originalCwd = process.cwd();
		process.chdir(fixture.repoPath);
		try {
			expectOk(await git.fetchPrune());
			const gone = expectOk(await git.listGoneBranches());
			expect(gone).toEqual(["feat"]);
		} finally {
			process.chdir(originalCwd);
		}
	});

	test("tracked branch without remote deletion is not gone", async () => {
		await using tmp = await createTempDir();
		const fixture = await createRemoteFixture(tmp.path);
		await fixture.addTrackedBranch("alive");

		const originalCwd = process.cwd();
		process.chdir(fixture.repoPath);
		try {
			expectOk(await git.fetchPrune());
			const gone = expectOk(await git.listGoneBranches());
			expect(gone).toEqual([]);
		} finally {
			process.chdir(originalCwd);
		}
	});

	test("unborn repo yields Result errors instead of crashes", async () => {
		await using tmp = await createTempDir();
		const repoPath = await initUnbornRepo(tmp.path);

		const message = await git.getLastCommitMessage(repoPath);
		expectErr(message);
		// Status checks on an unborn repo must still succeed.
		expect(expectOk(await git.isRebaseInProgress(repoPath))).toBe(false);
	});
});
