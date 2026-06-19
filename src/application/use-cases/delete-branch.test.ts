import { describe, expect, test } from "bun:test";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { deleteBranch } from "./delete-branch.ts";

describe("deleteBranch", () => {
	test("clean delete → deleted, remote skipped", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			mergedBranches: ["feature"],
		});
		const outcome = await deleteBranch({ branch: "feature", force: false, deleteRemote: false }, { git });
		expect(outcome).toEqual({ status: "deleted", remote: { status: "skipped" } });
	});

	test("not-merged + force=false → not-merged (no force fallback)", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			// not in mergedBranches → deleteBranch returns BRANCH_NOT_MERGED
		});
		const outcome = await deleteBranch({ branch: "feature", force: false, deleteRemote: false }, { git });
		expect(outcome).toEqual({ status: "not-merged" });

		// force-delete must NOT have been invoked — branch still listable
		const branches = await git.listBranches();
		expect(branches.success && branches.data.includes("feature")).toBe(true);
	});

	test("not-merged + force=true → deleted (force fallback)", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
		});
		const outcome = await deleteBranch({ branch: "feature", force: true, deleteRemote: false }, { git });
		expect(outcome).toEqual({ status: "deleted", remote: { status: "skipped" } });

		const branches = await git.listBranches();
		expect(branches.success && branches.data.includes("feature")).toBe(false);
	});

	test("delete fails with non-NOT_MERGED error → failed with message", async () => {
		const git = createFakeGit({
			branches: ["main"], // "feature" missing → BRANCH_NOT_FOUND
		});
		const outcome = await deleteBranch({ branch: "feature", force: false, deleteRemote: false }, { git });
		expect(outcome.status).toBe("failed");
		if (outcome.status === "failed") {
			expect(outcome.message).toContain("feature");
		}
	});

	test("delete fails with non-NOT_MERGED error → failed even when force=true", async () => {
		const git = createFakeGit({
			branches: ["main"], // BRANCH_NOT_FOUND is NOT recoverable via force
		});
		const outcome = await deleteBranch({ branch: "ghost", force: true, deleteRemote: false }, { git });
		// deleteBranch returns BRANCH_NOT_FOUND, which is not BRANCH_NOT_MERGED,
		// so force fallback must NOT be attempted.
		expect(outcome.status).toBe("failed");
	});

	test("force fallback fails → failed with force error message", async () => {
		// "feature" is not merged, so the normal delete returns BRANCH_NOT_MERGED and
		// triggers the force fallback. Stub deleteBranchForce to fail so we exercise the
		// "force fallback itself failed → failed" path.
		const baseGit = createFakeGit({ branches: ["main", "feature"] });
		const git = {
			...baseGit,
			async deleteBranchForce(_branch: string) {
				return { success: false as const, error: { code: "UNKNOWN" as const, message: "force boom" } };
			},
		};
		const outcome = await deleteBranch({ branch: "feature", force: true, deleteRemote: false }, { git });
		expect(outcome).toEqual({ status: "failed", message: "force boom" });
	});

	test("deleted + remote delete requested + remote ref exists → remote=deleted", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			mergedBranches: ["feature"],
			remoteBranches: ["feature"],
		});
		const outcome = await deleteBranch({ branch: "feature", force: false, deleteRemote: true }, { git });
		expect(outcome).toEqual({ status: "deleted", remote: { status: "deleted" } });
	});

	test("deleted + remote delete requested + remote ref missing → remote=not-found", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			mergedBranches: ["feature"],
			remoteBranches: [], // empty, but state-tracking is enabled because the option is provided
		});
		const outcome = await deleteBranch({ branch: "feature", force: false, deleteRemote: true }, { git });
		expect(outcome).toEqual({ status: "deleted", remote: { status: "not-found" } });
	});

	test("deleted + remote delete fails with other error → remote=failed", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			mergedBranches: ["feature"],
			deleteRemoteBranchFail: { code: "UNKNOWN", message: "network down" },
		});
		const outcome = await deleteBranch({ branch: "feature", force: false, deleteRemote: true }, { git });
		expect(outcome.status).toBe("deleted");
		if (outcome.status === "deleted") {
			expect(outcome.remote).toEqual({ status: "failed", message: "network down" });
		}
	});

	test("force fallback + remote delete → deleted + remote=deleted", async () => {
		const git = createFakeGit({
			branches: ["main", "feature"],
			// not merged → force fallback
			remoteBranches: ["feature"],
		});
		const outcome = await deleteBranch({ branch: "feature", force: true, deleteRemote: true }, { git });
		expect(outcome).toEqual({ status: "deleted", remote: { status: "deleted" } });
	});

	test("not-merged outcome must not attempt remote deletion", async () => {
		let remoteCalls = 0;
		const baseGit = createFakeGit({ branches: ["main", "feature"] });
		const git = {
			...baseGit,
			async deleteRemoteBranch(branch: string, remote?: string) {
				remoteCalls += 1;
				return baseGit.deleteRemoteBranch(branch, remote);
			},
		};
		const outcome = await deleteBranch({ branch: "feature", force: false, deleteRemote: true }, { git });
		expect(outcome).toEqual({ status: "not-merged" });
		expect(remoteCalls).toBe(0);
	});

	test("failed outcome must not attempt remote deletion", async () => {
		let remoteCalls = 0;
		const baseGit = createFakeGit({ branches: ["main"] });
		const git = {
			...baseGit,
			async deleteRemoteBranch(branch: string, remote?: string) {
				remoteCalls += 1;
				return baseGit.deleteRemoteBranch(branch, remote);
			},
		};
		const outcome = await deleteBranch({ branch: "ghost", force: false, deleteRemote: true }, { git });
		expect(outcome.status).toBe("failed");
		expect(remoteCalls).toBe(0);
	});
});
