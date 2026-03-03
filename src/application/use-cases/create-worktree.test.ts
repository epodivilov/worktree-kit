import { describe, expect, test } from "bun:test";
import { CONFIG_FILENAME } from "../../domain/constants.ts";
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
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: CONFIG, [`${ROOT}/.env`]: "SECRET=123" },
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
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: CONFIG, [`${ROOT}/.env`]: "SECRET=123" },
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
				[`${ROOT}/${CONFIG_FILENAME}`]: configWithDir,
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
		const fs = createFakeFilesystem({ files: { [`${ROOT}/${CONFIG_FILENAME}`]: CONFIG }, cwd: ROOT });
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
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: configWithHooks },
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
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: CONFIG },
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
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: configWithHooks },
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
				[`${ROOT}/${CONFIG_FILENAME}`]: config,
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
				[`${ROOT}/${CONFIG_FILENAME}`]: config,
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
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: config },
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
				[`${ROOT}/${CONFIG_FILENAME}`]: config,
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
				[`${ROOT}/${CONFIG_FILENAME}`]: config,
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

	test("expands recursive glob pattern matching dotfiles", async () => {
		const config = JSON.stringify({ rootDir: "../worktrees", copy: ["**/.env*"] });
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: {
				[`${ROOT}/${CONFIG_FILENAME}`]: config,
				[`${ROOT}/.env`]: "ROOT_SECRET=1",
				[`${ROOT}/.env.local`]: "LOCAL_SECRET=2",
				[`${ROOT}/packages/api/.env`]: "API_SECRET=3",
				[`${ROOT}/packages/api/.env.production`]: "API_PROD=4",
				[`${ROOT}/packages/web/.env`]: "WEB_SECRET=5",
			},
			directories: [`${ROOT}/packages`, `${ROOT}/packages/api`, `${ROOT}/packages/web`],
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-dotglob" }, { git, fs });

		const { filesToCopy } = expectOk(result);
		expect(filesToCopy).toHaveLength(5);
		const srcs = filesToCopy.map((f) => f.src).sort();
		expect(srcs).toEqual([
			`${ROOT}/.env`,
			`${ROOT}/.env.local`,
			`${ROOT}/packages/api/.env`,
			`${ROOT}/packages/api/.env.production`,
			`${ROOT}/packages/web/.env`,
		]);
	});

	test("expands recursive glob pattern matching exact dotfiles", async () => {
		const config = JSON.stringify({ rootDir: "../worktrees", copy: ["**/.env"] });
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: {
				[`${ROOT}/${CONFIG_FILENAME}`]: config,
				[`${ROOT}/.env`]: "ROOT=1",
				[`${ROOT}/.env.local`]: "should not match",
				[`${ROOT}/packages/api/.env`]: "API=2",
				[`${ROOT}/packages/api/.env.local`]: "should not match",
			},
			directories: [`${ROOT}/packages`, `${ROOT}/packages/api`],
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-dotexact" }, { git, fs });

		const { filesToCopy } = expectOk(result);
		expect(filesToCopy).toHaveLength(2);
		const srcs = filesToCopy.map((f) => f.src).sort();
		expect(srcs).toEqual([`${ROOT}/.env`, `${ROOT}/packages/api/.env`]);
	});

	test("dry-run does not create worktree but returns preview data", async () => {
		const configWithHooks = JSON.stringify({
			rootDir: "../worktrees",
			copy: [".env"],
			hooks: { "post-create": ["pnpm install"] },
		});
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: configWithHooks, [`${ROOT}/.env`]: "SECRET=123" },
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-dry", baseBranch: "main", dryRun: true }, { git, fs });

		const data = expectOk(result);
		expect(data.worktree.branch).toBe("feat-dry");
		expect(data.worktree.path).toContain("feat-dry");
		expect(data.filesToCopy).toHaveLength(1);
		expect(data.filesToCopy[0]?.src).toBe(`${ROOT}/.env`);
		expect(data.hookCommands).toEqual(["pnpm install"]);
	});

	test("dry-run does not add worktree to git store", async () => {
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: CONFIG },
			cwd: ROOT,
		});
		await createWorktree({ branch: "feat-dry-no-wt", dryRun: true }, { git, fs });

		const listResult = await git.listWorktrees();
		expect(listResult.success && listResult.data).toEqual([]);
	});

	test("returns symlinks to create from config", async () => {
		const config = JSON.stringify({ rootDir: "../worktrees", symlinks: [".env"] });
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: config, [`${ROOT}/.env`]: "SECRET=123" },
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-sym" }, { git, fs });

		const { symlinksToCreate, worktree } = expectOk(result);
		expect(symlinksToCreate).toHaveLength(1);
		expect(symlinksToCreate[0]?.target).toBe(`${ROOT}/.env`);
		expect(symlinksToCreate[0]?.linkPath).toBe(`${worktree.path}/.env`);
	});

	test("expands glob pattern in symlinks config", async () => {
		const config = JSON.stringify({ rootDir: "../worktrees", symlinks: ["config/*.json"] });
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: {
				[`${ROOT}/${CONFIG_FILENAME}`]: config,
				[`${ROOT}/config/db.json`]: "{}",
				[`${ROOT}/config/api.json`]: "{}",
			},
			directories: [`${ROOT}/config`],
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-sym-glob" }, { git, fs });

		const { symlinksToCreate } = expectOk(result);
		expect(symlinksToCreate).toHaveLength(2);
		const targets = symlinksToCreate.map((s) => s.target).sort();
		expect(targets).toEqual([`${ROOT}/config/api.json`, `${ROOT}/config/db.json`]);
	});

	test("warns when symlink glob matches no files", async () => {
		const config = JSON.stringify({ rootDir: "../worktrees", symlinks: ["nonexistent/*.json"] });
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: config },
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-sym-none" }, { git, fs });

		const { symlinksToCreate, notifications } = expectOk(result);
		expect(symlinksToCreate).toHaveLength(0);
		expect(notifications.some((n) => n.message.includes("No files matched symlink pattern"))).toBe(true);
	});

	test("deduplicates overlapping symlink paths", async () => {
		const config = JSON.stringify({ rootDir: "../worktrees", symlinks: [".env", ".*"] });
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: {
				[`${ROOT}/${CONFIG_FILENAME}`]: config,
				[`${ROOT}/.env`]: "SECRET=123",
				[`${ROOT}/.gitignore`]: "node_modules",
			},
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-sym-dedup" }, { git, fs });

		const { symlinksToCreate } = expectOk(result);
		const envEntries = symlinksToCreate.filter((s) => s.target === `${ROOT}/.env`);
		expect(envEntries).toHaveLength(1);
	});

	test("returns empty symlinks when not configured", async () => {
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: CONFIG },
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-no-sym" }, { git, fs });

		const { symlinksToCreate } = expectOk(result);
		expect(symlinksToCreate).toEqual([]);
	});

	test("warns and excludes symlink targets tracked by git", async () => {
		const config = JSON.stringify({ rootDir: "../worktrees", symlinks: [".env", "node_modules"] });
		const git = createFakeGit({ root: ROOT, worktrees: [], trackedPaths: new Set([".env"]) });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: config, [`${ROOT}/.env`]: "SECRET=123" },
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-tracked" }, { git, fs });

		const { symlinksToCreate, notifications } = expectOk(result);
		expect(symlinksToCreate).toHaveLength(1);
		expect(symlinksToCreate[0]?.target).toBe(`${ROOT}/node_modules`);
		expect(notifications.some((n) => n.level === "warn" && n.message.includes(".env"))).toBe(true);
		expect(notifications.some((n) => n.message.includes("copy"))).toBe(true);
	});

	test("does not warn for non-tracked symlink targets", async () => {
		const config = JSON.stringify({ rootDir: "../worktrees", symlinks: ["node_modules", ".cache"] });
		const git = createFakeGit({ root: ROOT, worktrees: [], trackedPaths: new Set() });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: config },
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-untracked" }, { git, fs });

		const { symlinksToCreate, notifications } = expectOk(result);
		expect(symlinksToCreate).toHaveLength(2);
		expect(notifications.filter((n) => n.message.includes("tracked by git"))).toHaveLength(0);
	});

	test("warns for tracked symlink targets from glob pattern", async () => {
		const config = JSON.stringify({ rootDir: "../worktrees", symlinks: ["config/*.json"] });
		const git = createFakeGit({ root: ROOT, worktrees: [], trackedPaths: new Set(["config/db.json"]) });
		const fs = createFakeFilesystem({
			files: {
				[`${ROOT}/${CONFIG_FILENAME}`]: config,
				[`${ROOT}/config/db.json`]: "{}",
				[`${ROOT}/config/local.json`]: "{}",
			},
			directories: [`${ROOT}/config`],
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-tracked-glob" }, { git, fs });

		const { symlinksToCreate, notifications } = expectOk(result);
		expect(symlinksToCreate).toHaveLength(1);
		expect(symlinksToCreate[0]?.target).toBe(`${ROOT}/config/local.json`);
		expect(notifications.some((n) => n.message.includes("config/db.json"))).toBe(true);
	});

	test("excludes literal negation pattern from copy", async () => {
		const config = JSON.stringify({
			rootDir: "../worktrees",
			copy: [".claude", "!.claude/settings.local.json"],
		});
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: {
				[`${ROOT}/${CONFIG_FILENAME}`]: config,
				[`${ROOT}/.claude/settings.local.json`]: "{}",
			},
			directories: [`${ROOT}/.claude`],
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-neg-literal" }, { git, fs });

		const { filesToCopy } = expectOk(result);
		expect(filesToCopy).toHaveLength(1);
		expect(filesToCopy[0]?.src).toBe(`${ROOT}/.claude`);
	});

	test("excludes glob negation pattern from copy", async () => {
		const config = JSON.stringify({
			rootDir: "../worktrees",
			copy: ["config/*", "!config/*.secret"],
		});
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: {
				[`${ROOT}/${CONFIG_FILENAME}`]: config,
				[`${ROOT}/config/db.json`]: "{}",
				[`${ROOT}/config/api.json`]: "{}",
				[`${ROOT}/config/keys.secret`]: "TOP_SECRET",
			},
			directories: [`${ROOT}/config`],
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-neg-glob" }, { git, fs });

		const { filesToCopy } = expectOk(result);
		expect(filesToCopy).toHaveLength(2);
		const srcs = filesToCopy.map((f) => f.src).sort();
		expect(srcs).toEqual([`${ROOT}/config/api.json`, `${ROOT}/config/db.json`]);
	});

	test("excludes negation pattern from symlinks", async () => {
		const config = JSON.stringify({
			rootDir: "../worktrees",
			symlinks: ["config/*", "!config/local.json"],
		});
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: {
				[`${ROOT}/${CONFIG_FILENAME}`]: config,
				[`${ROOT}/config/shared.json`]: "{}",
				[`${ROOT}/config/local.json`]: "{}",
			},
			directories: [`${ROOT}/config`],
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-neg-sym" }, { git, fs });

		const { symlinksToCreate } = expectOk(result);
		expect(symlinksToCreate).toHaveLength(1);
		expect(symlinksToCreate[0]?.target).toBe(`${ROOT}/config/shared.json`);
	});

	test("combined copy with exclusion + symlink excluded file", async () => {
		const config = JSON.stringify({
			rootDir: "../worktrees",
			copy: [".claude", "!.claude/settings.local.json"],
			symlinks: [".claude/settings.local.json"],
		});
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: {
				[`${ROOT}/${CONFIG_FILENAME}`]: config,
				[`${ROOT}/.claude/settings.local.json`]: "{}",
			},
			directories: [`${ROOT}/.claude`],
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-neg-combined" }, { git, fs });

		const { filesToCopy, symlinksToCreate } = expectOk(result);
		expect(filesToCopy).toHaveLength(1);
		expect(filesToCopy[0]?.src).toBe(`${ROOT}/.claude`);
		expect(symlinksToCreate).toHaveLength(1);
		expect(symlinksToCreate[0]?.target).toBe(`${ROOT}/.claude/settings.local.json`);
	});

	test("negation without matching positive is a no-op", async () => {
		const config = JSON.stringify({
			rootDir: "../worktrees",
			copy: [".env", "!nonexistent.txt"],
		});
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: config, [`${ROOT}/.env`]: "SECRET=123" },
			cwd: ROOT,
		});
		const result = await createWorktree({ branch: "feat-neg-noop" }, { git, fs });

		const { filesToCopy } = expectOk(result);
		expect(filesToCopy).toHaveLength(1);
		expect(filesToCopy[0]?.src).toBe(`${ROOT}/.env`);
	});

	test("deduplicates overlapping glob and literal paths", async () => {
		const config = JSON.stringify({ rootDir: "../worktrees", copy: [".env", ".*"] });
		const git = createFakeGit({ root: ROOT, worktrees: [] });
		const fs = createFakeFilesystem({
			files: {
				[`${ROOT}/${CONFIG_FILENAME}`]: config,
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
