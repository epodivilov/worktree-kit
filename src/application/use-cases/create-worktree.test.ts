import { describe, expect, test } from "bun:test";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { createFakeShell } from "../../test-utils/fake-shell.ts";
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
		const shell = createFakeShell();
		const result = await createWorktree({ branch: "feat-x" }, { git, fs, shell });

		const { worktree } = expectOk(result);
		expect(worktree.branch).toBe("feat-x");
		expect(worktree.isMain).toBe(false);
	});

	test("copies configured files from main worktree to new worktree", async () => {
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.worktreekitrc`]: CONFIG, [`${ROOT}/.env`]: "SECRET=123" },
			cwd: ROOT,
		});
		const shell = createFakeShell();
		const result = await createWorktree({ branch: "feat-copy" }, { git, fs, shell });

		const { worktree } = expectOk(result);
		const copied = expectOk(await fs.readFile(`${worktree.path}/.env`));
		expect(copied).toBe("SECRET=123");
	});

	test("returns error when branch already exists", async () => {
		const git = createFakeGit({
			root: ROOT,
			worktrees: [{ path: "/other", branch: "existing", head: "abc", isMain: false }],
		});
		const fs = createFakeFilesystem({ files: { [`${ROOT}/.worktreekitrc`]: CONFIG }, cwd: ROOT });
		const shell = createFakeShell();
		const result = await createWorktree({ branch: "existing" }, { git, fs, shell });

		expectErr(result);
	});

	test("works without .worktree.json (no files to copy)", async () => {
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({ cwd: ROOT });
		const shell = createFakeShell();
		const result = await createWorktree({ branch: "feat-noconf" }, { git, fs, shell });

		expectOk(result);
	});

	test("returns error when not in a git repository", async () => {
		const git = createFakeGit({ isRepo: false });
		const fs = createFakeFilesystem({ cwd: ROOT });
		const shell = createFakeShell();
		const result = await createWorktree({ branch: "feat-x" }, { git, fs, shell });

		expectErr(result);
	});

	test("executes post-create hooks when configured", async () => {
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
		const shell = createFakeShell();
		const result = await createWorktree({ branch: "feat-hooks" }, { git, fs, shell });

		expectOk(result);
		expect(shell.calls).toHaveLength(2);
		expect(shell.calls[0]?.command).toBe("pnpm install");
		expect(shell.calls[1]?.command).toBe("echo done");
	});

	test("does not run hooks when post-create is empty", async () => {
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.worktreekitrc`]: CONFIG },
			cwd: ROOT,
		});
		const shell = createFakeShell();
		await createWorktree({ branch: "feat-no-hooks" }, { git, fs, shell });

		expect(shell.calls).toHaveLength(0);
	});

	test("includes hook notifications in result", async () => {
		const configWithHooks = JSON.stringify({
			rootDir: "../worktrees",
			copy: [],
			hooks: { "post-create": ["pnpm install"] },
		});
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.worktreekitrc`]: configWithHooks },
			cwd: ROOT,
		});
		const shell = createFakeShell();
		const result = await createWorktree({ branch: "feat-notif" }, { git, fs, shell });

		const { notifications } = expectOk(result);
		expect(notifications.some((n) => n.message.includes("pnpm install"))).toBe(true);
	});
});
