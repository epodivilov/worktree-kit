import { describe, expect, test } from "bun:test";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { createWorktree } from "./create-worktree.ts";

describe("createWorktree", () => {
	const ROOT = "/fake/project";
	const CONFIG = JSON.stringify({ rootDir: "../worktrees", copy: [".env"] });

	test("creates a worktree and returns it on success", async () => {
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.worktree.json`]: CONFIG, [`${ROOT}/.env`]: "SECRET=123" },
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-x" }, { git, fs });

		const { worktree } = expectOk(result);
		expect(worktree.branch).toBe("feat-x");
		expect(worktree.isMain).toBe(false);
	});

	test("copies configured files from main worktree to new worktree", async () => {
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.worktree.json`]: CONFIG, [`${ROOT}/.env`]: "SECRET=123" },
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-copy" }, { git, fs });

		const { worktree } = expectOk(result);
		const copied = expectOk(await fs.readFile(`${worktree.path}/.env`));
		expect(copied).toBe("SECRET=123");
	});

	test("returns error when branch already exists", async () => {
		const git = createFakeGit({
			root: ROOT,
			worktrees: [{ path: "/other", branch: "existing", head: "abc", isMain: false }],
		});
		const fs = createFakeFilesystem({ files: { [`${ROOT}/.worktree.json`]: CONFIG }, cwd: ROOT });
		const result = await createWorktree({ branch: "existing" }, { git, fs });

		expectErr(result);
	});

	test("works without .worktree.json (no files to copy)", async () => {
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({ cwd: ROOT });
		const result = await createWorktree({ branch: "feat-noconf" }, { git, fs });

		expectOk(result);
	});

	test("returns error when not in a git repository", async () => {
		const git = createFakeGit({ isRepo: false });
		const fs = createFakeFilesystem({ cwd: ROOT });
		const result = await createWorktree({ branch: "feat-x" }, { git, fs });

		expectErr(result);
	});
});
