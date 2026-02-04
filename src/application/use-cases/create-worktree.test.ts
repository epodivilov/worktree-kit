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
			files: { [`${ROOT}/.worktreekitrc`]: CONFIG, [`${ROOT}/.env`]: "SECRET=123" },
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-x" }, { git, fs });

		const { worktree } = expectOk(result);
		expect(worktree.branch).toBe("feat-x");
		expect(worktree.isMain).toBe(false);
	});

	test("returns files to copy from config", async () => {
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.worktreekitrc`]: CONFIG, [`${ROOT}/.env`]: "SECRET=123" },
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-copy" }, { git, fs });

		const { filesToCopy, worktree } = expectOk(result);
		expect(filesToCopy).toHaveLength(1);
		expect(filesToCopy[0]?.src).toBe(`${ROOT}/.env`);
		expect(filesToCopy[0]?.dest).toBe(`${worktree.path}/.env`);
	});

	test("returns error when branch already exists", async () => {
		const git = createFakeGit({
			root: ROOT,
			worktrees: [{ path: "/other", branch: "existing", head: "abc", isMain: false }],
		});
		const fs = createFakeFilesystem({ files: { [`${ROOT}/.worktreekitrc`]: CONFIG }, cwd: ROOT });
		const result = await createWorktree({ branch: "existing" }, { git, fs });

		expectErr(result);
	});

	test("works without config (no files to copy)", async () => {
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({ cwd: ROOT });
		const result = await createWorktree({ branch: "feat-noconf" }, { git, fs });

		const data = expectOk(result);
		expect(data.filesToCopy).toEqual([]);
		expect(data.hookCommands).toEqual([]);
		expect(data.hookContext).toBeNull();
	});

	test("returns error when not in a git repository", async () => {
		const git = createFakeGit({ isRepo: false });
		const fs = createFakeFilesystem({ cwd: ROOT });
		const result = await createWorktree({ branch: "feat-x" }, { git, fs });

		expectErr(result);
	});

	test("returns hook context and commands when configured", async () => {
		const configWithHooks = JSON.stringify({
			rootDir: "../worktrees",
			copy: [],
			hooks: { "post-create": ["pnpm install", "echo done"] },
		});
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.worktreekitrc`]: configWithHooks },
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-hooks" }, { git, fs });

		const data = expectOk(result);
		expect(data.hookCommands).toEqual(["pnpm install", "echo done"]);
		expect(data.hookContext).not.toBeNull();
		expect(data.hookContext?.branch).toBe("feat-hooks");
		expect(data.hookContext?.worktreePath).toContain("feat-hooks");
		expect(data.hookContext?.repoRoot).toBe(ROOT);
	});

	test("returns null hookContext when no hooks configured", async () => {
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.worktreekitrc`]: CONFIG },
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-no-hooks" }, { git, fs });

		const data = expectOk(result);
		expect(data.hookCommands).toEqual([]);
		expect(data.hookContext).toBeNull();
	});

	test("includes baseBranch in hook context when provided", async () => {
		const configWithHooks = JSON.stringify({
			rootDir: "../worktrees",
			copy: [],
			hooks: { "post-create": ["echo test"] },
		});
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.worktreekitrc`]: configWithHooks },
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-base", baseBranch: "develop" }, { git, fs });

		const data = expectOk(result);
		expect(data.hookContext?.baseBranch).toBe("develop");
	});
});
