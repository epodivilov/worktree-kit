import { describe, expect, test } from "bun:test";
import type { WorktreeConfig } from "../../domain/entities/config.ts";
import type { Worktree } from "../../domain/entities/worktree.ts";
import { Result } from "../../shared/result.ts";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { createFakeShell } from "../../test-utils/fake-shell.ts";
import type { LoadConfigOutput } from "./load-config.ts";
import { syncWorktrees } from "./sync-worktrees.ts";

const ROOT = "/fake/project";
const WT_A = "/fake/worktrees/feat-a";
const WT_B = "/fake/worktrees/feat-b";

function makeConfig(overrides: Partial<WorktreeConfig> = {}): WorktreeConfig {
	return {
		rootDir: "../worktrees",
		copy: [],
		symlinks: [],
		hooks: {
			"post-create": [],
			"pre-remove": [],
			"post-update": [],
			"on-conflict": [],
			"post-sync": [],
		},
		defaultBase: "ask",
		create: {},
		remove: {},
		...overrides,
	};
}

function makeConfigResult(overrides: Partial<LoadConfigOutput> = {}) {
	return Result.ok<LoadConfigOutput>({
		config: makeConfig(),
		configPath: `${ROOT}/.worktreekit.jsonc`,
		localConfigPath: null,
		globalConfigPath: null,
		isLegacyConfig: false,
		globalOverrides: null,
		repoOverrides: { rootDir: "../worktrees" },
		localOverrides: null,
		...overrides,
	});
}

function worktree(path: string, branch: string): Worktree {
	return { path, branch, head: "abc", isMain: false, isPrunable: false };
}

describe("syncWorktrees", () => {
	test("creates missing symlinks (AC #1)", async () => {
		const config = makeConfig({ symlinks: ["node_modules"] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/node_modules/x.js`]: "" },
			directories: [`${ROOT}/node_modules`],
			cwd: ROOT,
		});
		const git = createFakeGit({
			root: ROOT,
			worktrees: [{ ...worktree(ROOT, "main"), isMain: true }, worktree(WT_A, "feat-a")],
		});

		const result = await syncWorktrees(
			{
				dryRun: false,
				force: false,
				postSyncHooks: [],
				repoRoot: ROOT,
				config,
				configResult: makeConfigResult({ config }),
			},
			{ git, fs },
		);

		const { reports } = expectOk(result);
		expect(reports).toHaveLength(1);
		expect(reports[0]?.addedSymlinks).toContain(`${WT_A}/node_modules`);
		expect(await fs.isSymlink(`${WT_A}/node_modules`)).toBe(true);
	});

	test("copies missing files (AC #2)", async () => {
		const config = makeConfig({ copy: [".env"] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.env`]: "S=1" },
			cwd: ROOT,
		});
		const git = createFakeGit({
			root: ROOT,
			worktrees: [{ ...worktree(ROOT, "main"), isMain: true }, worktree(WT_A, "feat-a")],
		});

		const result = await syncWorktrees(
			{
				dryRun: false,
				force: false,
				postSyncHooks: [],
				repoRoot: ROOT,
				config,
				configResult: makeConfigResult({ config }),
			},
			{ git, fs },
		);

		const { reports } = expectOk(result);
		expect(reports[0]?.copiedFiles).toContain(`${WT_A}/.env`);
		expect(expectOk(await fs.readFile(`${WT_A}/.env`))).toBe("S=1");
	});

	test("--dry-run makes no writes (AC #3)", async () => {
		const config = makeConfig({ copy: [".env"], symlinks: ["node_modules"] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.env`]: "S=1", [`${ROOT}/node_modules/x.js`]: "" },
			directories: [`${ROOT}/node_modules`],
			cwd: ROOT,
		});
		const git = createFakeGit({
			root: ROOT,
			worktrees: [{ ...worktree(ROOT, "main"), isMain: true }, worktree(WT_A, "feat-a")],
		});

		const result = await syncWorktrees(
			{
				dryRun: true,
				force: false,
				postSyncHooks: [],
				repoRoot: ROOT,
				config,
				configResult: makeConfigResult({ config }),
			},
			{ git, fs },
		);

		const { reports } = expectOk(result);
		expect(reports[0]?.copiedFiles).toContain(`${WT_A}/.env`);
		expect(reports[0]?.addedSymlinks).toContain(`${WT_A}/node_modules`);
		expect(await fs.exists(`${WT_A}/.env`)).toBe(false);
		expect(await fs.isSymlink(`${WT_A}/node_modules`)).toBe(false);
	});

	test("targets a single worktree by branch (AC #4)", async () => {
		const config = makeConfig({ copy: [".env"] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.env`]: "S=1" },
			cwd: ROOT,
		});
		const git = createFakeGit({
			root: ROOT,
			worktrees: [{ ...worktree(ROOT, "main"), isMain: true }, worktree(WT_A, "feat-a"), worktree(WT_B, "feat-b")],
		});

		const result = await syncWorktrees(
			{
				branch: "feat-a",
				dryRun: false,
				force: false,
				postSyncHooks: [],
				repoRoot: ROOT,
				config,
				configResult: makeConfigResult({ config }),
			},
			{ git, fs },
		);

		const { reports } = expectOk(result);
		expect(reports).toHaveLength(1);
		expect(reports[0]?.branch).toBe("feat-a");
		expect(await fs.exists(`${WT_A}/.env`)).toBe(true);
		expect(await fs.exists(`${WT_B}/.env`)).toBe(false);
	});

	test("targets all non-main worktrees by default (AC #4)", async () => {
		const config = makeConfig({ copy: [".env"] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.env`]: "S=1" },
			cwd: ROOT,
		});
		const git = createFakeGit({
			root: ROOT,
			worktrees: [{ ...worktree(ROOT, "main"), isMain: true }, worktree(WT_A, "feat-a"), worktree(WT_B, "feat-b")],
		});

		const result = await syncWorktrees(
			{
				dryRun: false,
				force: false,
				postSyncHooks: [],
				repoRoot: ROOT,
				config,
				configResult: makeConfigResult({ config }),
			},
			{ git, fs },
		);

		const { reports } = expectOk(result);
		expect(reports).toHaveLength(2);
		expect(reports.map((r) => r.branch).sort()).toEqual(["feat-a", "feat-b"]);
	});

	test("returns error when target branch not found", async () => {
		const config = makeConfig();
		const fs = createFakeFilesystem({ cwd: ROOT });
		const git = createFakeGit({
			root: ROOT,
			worktrees: [{ ...worktree(ROOT, "main"), isMain: true }],
		});

		const result = await syncWorktrees(
			{
				branch: "missing",
				dryRun: false,
				force: false,
				postSyncHooks: [],
				repoRoot: ROOT,
				config,
				configResult: makeConfigResult({ config }),
			},
			{ git, fs },
		);

		const error = expectErr(result);
		expect(error.message).toContain("missing");
	});

	test("does NOT run post-create hooks; runs post-sync hooks (AC #5)", async () => {
		const config = makeConfig({
			copy: [".env"],
			hooks: {
				"post-create": ["echo created"],
				"pre-remove": [],
				"post-update": [],
				"on-conflict": [],
				"post-sync": ["echo synced"],
			},
		});
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.env`]: "S=1" },
			cwd: ROOT,
		});
		const git = createFakeGit({
			root: ROOT,
			worktrees: [{ ...worktree(ROOT, "main"), isMain: true }, worktree(WT_A, "feat-a")],
		});
		const shell = createFakeShell();

		const result = await syncWorktrees(
			{
				dryRun: false,
				force: false,
				postSyncHooks: config.hooks["post-sync"],
				repoRoot: ROOT,
				config,
				configResult: makeConfigResult({ config }),
			},
			{ git, fs, shell },
		);

		expectOk(result);
		expect(shell.calls.map((c) => c.command)).toEqual(["echo synced"]);
		const call = shell.calls[0];
		expect(call?.options.cwd).toBe(WT_A);
		expect(call?.options.env?.WORKTREE_PATH).toBe(WT_A);
		expect(call?.options.env?.WORKTREE_BRANCH).toBe("feat-a");
		expect(call?.options.env?.REPO_ROOT).toBe(ROOT);
	});

	test("does not run post-sync hooks in dry-run", async () => {
		const config = makeConfig();
		const fs = createFakeFilesystem({ cwd: ROOT });
		const git = createFakeGit({
			root: ROOT,
			worktrees: [{ ...worktree(ROOT, "main"), isMain: true }, worktree(WT_A, "feat-a")],
		});
		const shell = createFakeShell();

		await syncWorktrees(
			{
				dryRun: true,
				force: false,
				postSyncHooks: ["echo synced"],
				repoRoot: ROOT,
				config,
				configResult: makeConfigResult({ config }),
			},
			{ git, fs, shell },
		);

		expect(shell.calls).toHaveLength(0);
	});

	test("is idempotent — second run is a no-op (AC #6)", async () => {
		const config = makeConfig({ copy: [".env"], symlinks: ["node_modules"] });
		const fs = createFakeFilesystem({
			files: {
				[`${ROOT}/.env`]: "S=1",
				[`${ROOT}/node_modules/x.js`]: "",
				[`${ROOT}/.worktreekit.jsonc`]: "{}",
			},
			directories: [`${ROOT}/node_modules`],
			cwd: ROOT,
		});
		const git = createFakeGit({
			root: ROOT,
			worktrees: [{ ...worktree(ROOT, "main"), isMain: true }, worktree(WT_A, "feat-a")],
		});

		const first = await syncWorktrees(
			{
				dryRun: false,
				force: false,
				postSyncHooks: [],
				repoRoot: ROOT,
				config,
				configResult: makeConfigResult({ config }),
			},
			{ git, fs },
		);
		const firstReports = expectOk(first).reports;
		expect(firstReports[0]?.copiedFiles.length).toBeGreaterThan(0);
		expect(firstReports[0]?.addedSymlinks.length).toBeGreaterThan(0);

		const second = await syncWorktrees(
			{
				dryRun: false,
				force: false,
				postSyncHooks: [],
				repoRoot: ROOT,
				config,
				configResult: makeConfigResult({ config }),
			},
			{ git, fs },
		);
		const secondReports = expectOk(second).reports;
		expect(secondReports[0]?.copiedFiles).toEqual([]);
		expect(secondReports[0]?.addedSymlinks).toEqual([]);
		expect(secondReports[0]?.recreatedSymlinks).toEqual([]);
		expect(secondReports[0]?.overwrittenFiles).toEqual([]);
		expect(secondReports[0]?.skippedFiles).toEqual([`${WT_A}/.env`]);
	});

	test("recreates broken symlinks (AC #7)", async () => {
		const config = makeConfig({ symlinks: ["node_modules"] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/node_modules/x.js`]: "" },
			directories: [`${ROOT}/node_modules`],
			brokenSymlinks: [`${WT_A}/node_modules`],
			cwd: ROOT,
		});
		const git = createFakeGit({
			root: ROOT,
			worktrees: [{ ...worktree(ROOT, "main"), isMain: true }, worktree(WT_A, "feat-a")],
		});

		const result = await syncWorktrees(
			{
				dryRun: false,
				force: false,
				postSyncHooks: [],
				repoRoot: ROOT,
				config,
				configResult: makeConfigResult({ config }),
			},
			{ git, fs },
		);

		const { reports } = expectOk(result);
		expect(reports[0]?.recreatedSymlinks).toContain(`${WT_A}/node_modules`);
		expect(await fs.isSymlinkBroken(`${WT_A}/node_modules`)).toBe(false);
		expect(await fs.isSymlink(`${WT_A}/node_modules`)).toBe(true);
	});

	test("skips existing files at copy dest without --force (AC #7)", async () => {
		const config = makeConfig({ copy: [".env"] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.env`]: "NEW=1", [`${WT_A}/.env`]: "OLD=1" },
			cwd: ROOT,
		});
		const git = createFakeGit({
			root: ROOT,
			worktrees: [{ ...worktree(ROOT, "main"), isMain: true }, worktree(WT_A, "feat-a")],
		});

		const result = await syncWorktrees(
			{
				dryRun: false,
				force: false,
				postSyncHooks: [],
				repoRoot: ROOT,
				config,
				configResult: makeConfigResult({ config }),
			},
			{ git, fs },
		);

		const { reports } = expectOk(result);
		expect(reports[0]?.skippedFiles).toContain(`${WT_A}/.env`);
		expect(reports[0]?.copiedFiles).toEqual([]);
		expect(expectOk(await fs.readFile(`${WT_A}/.env`))).toBe("OLD=1");
	});

	test("--force overwrites existing files at copy dest", async () => {
		const config = makeConfig({ copy: [".env"] });
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.env`]: "NEW=1", [`${WT_A}/.env`]: "OLD=1" },
			cwd: ROOT,
		});
		const git = createFakeGit({
			root: ROOT,
			worktrees: [{ ...worktree(ROOT, "main"), isMain: true }, worktree(WT_A, "feat-a")],
		});

		const result = await syncWorktrees(
			{
				dryRun: false,
				force: true,
				postSyncHooks: [],
				repoRoot: ROOT,
				config,
				configResult: makeConfigResult({ config }),
			},
			{ git, fs },
		);

		const { reports } = expectOk(result);
		expect(reports[0]?.overwrittenFiles).toContain(`${WT_A}/.env`);
		expect(reports[0]?.skippedFiles).toEqual([]);
		expect(expectOk(await fs.readFile(`${WT_A}/.env`))).toBe("NEW=1");
	});
});
