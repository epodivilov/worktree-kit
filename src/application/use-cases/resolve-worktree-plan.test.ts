import { describe, expect, test } from "bun:test";
import type { WorktreeConfig } from "../../domain/entities/config.ts";
import { Result } from "../../shared/result.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import type { LoadConfigOutput } from "./load-config.ts";
import { resolveWorktreePlan } from "./resolve-worktree-plan.ts";

const ROOT = "/fake/project";
const WORKTREE = "/fake/worktrees/feat";

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

describe("resolveWorktreePlan", () => {
	test("returns files from copy config", async () => {
		const fs = createFakeFilesystem({ files: { [`${ROOT}/.env`]: "S=1" }, cwd: ROOT });
		const git = createFakeGit({ root: ROOT });

		const plan = await resolveWorktreePlan(
			{
				repoRoot: ROOT,
				worktreePath: WORKTREE,
				config: makeConfig({ copy: [".env"] }),
				configResult: makeConfigResult(),
			},
			{ fs, git },
		);

		expect(plan.filesToCopy).toHaveLength(1);
		expect(plan.filesToCopy[0]?.src).toBe(`${ROOT}/.env`);
		expect(plan.filesToCopy[0]?.dest).toBe(`${WORKTREE}/.env`);
	});

	test("returns symlinks from config", async () => {
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/node_modules/x.js`]: "" },
			directories: [`${ROOT}/node_modules`],
			cwd: ROOT,
		});
		const git = createFakeGit({ root: ROOT });

		const plan = await resolveWorktreePlan(
			{
				repoRoot: ROOT,
				worktreePath: WORKTREE,
				config: makeConfig({ symlinks: ["node_modules"] }),
				configResult: makeConfigResult(),
			},
			{ fs, git },
		);

		expect(plan.symlinksToCreate).toHaveLength(1);
		expect(plan.symlinksToCreate[0]?.target).toBe(`${ROOT}/node_modules`);
	});

	test("returns configSymlink when config is non-legacy and untracked", async () => {
		const fs = createFakeFilesystem({ cwd: ROOT });
		const git = createFakeGit({ root: ROOT });

		const plan = await resolveWorktreePlan(
			{
				repoRoot: ROOT,
				worktreePath: WORKTREE,
				config: makeConfig(),
				configResult: makeConfigResult(),
			},
			{ fs, git },
		);

		expect(plan.configSymlink?.target).toBe(`${ROOT}/.worktreekit.jsonc`);
		expect(plan.configSymlink?.linkPath).toBe(`${WORKTREE}/.worktreekit.jsonc`);
	});

	test("returns null configSymlink when config is legacy", async () => {
		const fs = createFakeFilesystem({ cwd: ROOT });
		const git = createFakeGit({ root: ROOT });

		const plan = await resolveWorktreePlan(
			{
				repoRoot: ROOT,
				worktreePath: WORKTREE,
				config: makeConfig(),
				configResult: makeConfigResult({ isLegacyConfig: true }),
			},
			{ fs, git },
		);

		expect(plan.configSymlink).toBeNull();
	});

	test("returns localConfigSymlink when localConfigPath is set", async () => {
		const fs = createFakeFilesystem({ cwd: ROOT });
		const git = createFakeGit({ root: ROOT });

		const plan = await resolveWorktreePlan(
			{
				repoRoot: ROOT,
				worktreePath: WORKTREE,
				config: makeConfig(),
				configResult: makeConfigResult({ localConfigPath: `${ROOT}/.worktreekit.local.jsonc` }),
			},
			{ fs, git },
		);

		expect(plan.localConfigSymlink?.target).toBe(`${ROOT}/.worktreekit.local.jsonc`);
		expect(plan.localConfigSymlink?.linkPath).toBe(`${WORKTREE}/.worktreekit.local.jsonc`);
	});

	test("skips configSymlink when config is tracked by git", async () => {
		const fs = createFakeFilesystem({ cwd: ROOT });
		const git = createFakeGit({ root: ROOT, trackedPaths: new Set([".worktreekit.jsonc"]) });

		const plan = await resolveWorktreePlan(
			{
				repoRoot: ROOT,
				worktreePath: WORKTREE,
				config: makeConfig(),
				configResult: makeConfigResult(),
			},
			{ fs, git },
		);

		expect(plan.configSymlink).toBeNull();
		expect(plan.notifications.some((n) => n.message.includes("tracked by git"))).toBe(true);
	});

	test("returns no config symlinks when configResult is null", async () => {
		const fs = createFakeFilesystem({ cwd: ROOT });
		const git = createFakeGit({ root: ROOT });

		const plan = await resolveWorktreePlan(
			{
				repoRoot: ROOT,
				worktreePath: WORKTREE,
				config: makeConfig(),
				configResult: null,
			},
			{ fs, git },
		);

		expect(plan.configSymlink).toBeNull();
		expect(plan.localConfigSymlink).toBeNull();
	});

	test("skips copy entry when source is missing in repo root", async () => {
		const fs = createFakeFilesystem({ cwd: ROOT });
		const git = createFakeGit({ root: ROOT });

		const plan = await resolveWorktreePlan(
			{
				repoRoot: ROOT,
				worktreePath: WORKTREE,
				config: makeConfig({ copy: [".env"] }),
				configResult: makeConfigResult(),
			},
			{ fs, git },
		);

		expect(plan.filesToCopy).toEqual([]);
		expect(
			plan.notifications.some((n) => n.level === "warn" && n.message.includes(`Copy source ".env" not found`)),
		).toBe(true);
	});

	test("skips symlink entry when target is missing in repo root", async () => {
		const fs = createFakeFilesystem({ cwd: ROOT });
		const git = createFakeGit({ root: ROOT });

		const plan = await resolveWorktreePlan(
			{
				repoRoot: ROOT,
				worktreePath: WORKTREE,
				config: makeConfig({ symlinks: ["node_modules"] }),
				configResult: makeConfigResult(),
			},
			{ fs, git },
		);

		expect(plan.symlinksToCreate).toEqual([]);
		expect(
			plan.notifications.some(
				(n) => n.level === "warn" && n.message.includes(`Symlink target "node_modules" not found`),
			),
		).toBe(true);
	});

	test("excludes negation pattern from copy", async () => {
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/.claude/settings.local.json`]: "{}" },
			directories: [`${ROOT}/.claude`],
			cwd: ROOT,
		});
		const git = createFakeGit({ root: ROOT });

		const plan = await resolveWorktreePlan(
			{
				repoRoot: ROOT,
				worktreePath: WORKTREE,
				config: makeConfig({ copy: [".claude", "!.claude/settings.local.json"] }),
				configResult: makeConfigResult(),
			},
			{ fs, git },
		);

		expect(plan.filesToCopy).toHaveLength(1);
		expect(plan.filesToCopy[0]?.src).toBe(`${ROOT}/.claude`);
	});
});
