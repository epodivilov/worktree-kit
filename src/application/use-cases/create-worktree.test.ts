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

	test("returns files to copy from config with isDirectory false", async () => {
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
		expect(filesToCopy[0]?.isDirectory).toBe(false);
	});

	test("marks directories in filesToCopy with isDirectory true", async () => {
		const configWithDir = JSON.stringify({ rootDir: "../worktrees", copy: [".env", "config"] });
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: {
				[`${ROOT}/.worktreekitrc`]: configWithDir,
				[`${ROOT}/.env`]: "SECRET=123",
				[`${ROOT}/config/settings.json`]: "{}",
			},
			directories: [`${ROOT}/config`],
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-dir" }, { git, fs });

		const { filesToCopy } = expectOk(result);
		expect(filesToCopy).toHaveLength(2);
		expect(filesToCopy[0]?.isDirectory).toBe(false);
		expect(filesToCopy[1]?.isDirectory).toBe(true);
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

	test("expands glob pattern to matching files", async () => {
		const config = JSON.stringify({ rootDir: "../worktrees", copy: ["config/*.json"] });
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: {
				[`${ROOT}/.worktreekitrc`]: config,
				[`${ROOT}/config/db.json`]: "{}",
				[`${ROOT}/config/api.json`]: "{}",
				[`${ROOT}/config/readme.txt`]: "not matched",
			},
			directories: [`${ROOT}/config`],
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-glob" }, { git, fs });

		const { filesToCopy } = expectOk(result);
		expect(filesToCopy).toHaveLength(2);
		const srcs = filesToCopy.map((f) => f.src).sort();
		expect(srcs).toEqual([`${ROOT}/config/api.json`, `${ROOT}/config/db.json`]);
	});

	test("expands recursive glob pattern", async () => {
		const config = JSON.stringify({ rootDir: "../worktrees", copy: ["config/**/*.json"] });
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: {
				[`${ROOT}/.worktreekitrc`]: config,
				[`${ROOT}/config/db/settings.json`]: "{}",
				[`${ROOT}/config/api/endpoints.json`]: "{}",
			},
			directories: [`${ROOT}/config`, `${ROOT}/config/db`, `${ROOT}/config/api`],
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-glob-deep" }, { git, fs });

		const { filesToCopy } = expectOk(result);
		expect(filesToCopy).toHaveLength(2);
		expect(filesToCopy[0]?.dest).toContain("config/");
		expect(filesToCopy[1]?.dest).toContain("config/");
	});

	test("warns when glob matches no files", async () => {
		const config = JSON.stringify({ rootDir: "../worktrees", copy: ["nonexistent/*.json"] });
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.worktreekitrc`]: config },
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-no-match" }, { git, fs });

		const { filesToCopy, notifications } = expectOk(result);
		expect(filesToCopy).toHaveLength(0);
		expect(notifications.some((n) => n.level === "warn" && n.message.includes("No files matched"))).toBe(true);
	});

	test("mixes literal paths and glob patterns", async () => {
		const config = JSON.stringify({ rootDir: "../worktrees", copy: [".env", "config/*.json"] });
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: {
				[`${ROOT}/.worktreekitrc`]: config,
				[`${ROOT}/.env`]: "SECRET=123",
				[`${ROOT}/config/db.json`]: "{}",
			},
			directories: [`${ROOT}/config`],
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-mixed" }, { git, fs });

		const { filesToCopy } = expectOk(result);
		expect(filesToCopy).toHaveLength(2);
		expect(filesToCopy[0]?.src).toBe(`${ROOT}/.env`);
		expect(filesToCopy[1]?.src).toBe(`${ROOT}/config/db.json`);
	});

	test("glob matching directories marks isDirectory true", async () => {
		const config = JSON.stringify({ rootDir: "../worktrees", copy: ["config/*"] });
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: {
				[`${ROOT}/.worktreekitrc`]: config,
				[`${ROOT}/config/settings.json`]: "{}",
				[`${ROOT}/config/nested/deep.json`]: "{}",
			},
			directories: [`${ROOT}/config`, `${ROOT}/config/nested`],
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-glob-dir" }, { git, fs });

		const { filesToCopy } = expectOk(result);
		const dirEntry = filesToCopy.find((f) => f.isDirectory);
		expect(dirEntry).toBeDefined();
		expect(dirEntry?.src).toBe(`${ROOT}/config/nested`);
	});

	test("deduplicates overlapping glob and literal paths", async () => {
		const config = JSON.stringify({ rootDir: "../worktrees", copy: [".env", ".*"] });
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: {
				[`${ROOT}/.worktreekitrc`]: config,
				[`${ROOT}/.env`]: "SECRET=123",
				[`${ROOT}/.gitignore`]: "node_modules",
			},
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-dedup" }, { git, fs });

		const { filesToCopy } = expectOk(result);
		const envEntries = filesToCopy.filter((f) => f.src === `${ROOT}/.env`);
		expect(envEntries).toHaveLength(1);
	});
});
