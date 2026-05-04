import { describe, expect, test } from "bun:test";
import { CONFIG_FILENAME } from "../../domain/constants.ts";
import type { Worktree } from "../../domain/entities/worktree.ts";
import { expectOk } from "../../test-utils/assertions.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { runHealthCheck } from "./run-health-check.ts";

const ROOT = "/fake/project";
const CONFIG_PATH = `${ROOT}/${CONFIG_FILENAME}`;
const ROOT_DIR = "/fake/worktrees";

const mainWt: Worktree = { path: ROOT, branch: "main", head: "aaa", isMain: true };
const featureWt: Worktree = { path: `${ROOT_DIR}/feature`, branch: "feature", head: "bbb", isMain: false };

function configFile(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({ rootDir: ROOT_DIR, ...overrides });
}

describe("runHealthCheck", () => {
	test("clean repo — healthy", async () => {
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: configFile() },
			directories: [ROOT, ROOT_DIR, featureWt.path],
		});
		const git = createFakeGit({ root: ROOT, worktrees: [mainWt, featureWt] });

		const report = expectOk(await runHealthCheck({ git, fs }));

		expect(report.healthy).toBe(true);
		expect(report.issues).toHaveLength(0);
	});

	test("empty prefix directory — flagged as warning", async () => {
		const emptyPrefix = `${ROOT_DIR}/ci`;
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: configFile() },
			directories: [ROOT, ROOT_DIR, featureWt.path, emptyPrefix],
		});
		const git = createFakeGit({ root: ROOT, worktrees: [mainWt, featureWt] });

		const report = expectOk(await runHealthCheck({ git, fs }));

		expect(report.healthy).toBe(false);
		expect(report.issues).toContainEqual({
			type: "empty-prefix-directory",
			severity: "warning",
			path: emptyPrefix,
		});
	});

	test("active prefix dir with worktree inside — NOT flagged", async () => {
		const prefixDir = `${ROOT_DIR}/feat`;
		const nestedWtPath = `${prefixDir}/my-feature`;
		const nestedWt: Worktree = { path: nestedWtPath, branch: "feat/my-feature", head: "ccc", isMain: false };
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: configFile() },
			directories: [ROOT, ROOT_DIR, prefixDir, nestedWtPath],
		});
		const git = createFakeGit({ root: ROOT, worktrees: [mainWt, nestedWt] });

		const report = expectOk(await runHealthCheck({ git, fs }));

		expect(report.healthy).toBe(true);
		expect(report.issues.filter((i) => i.type === "empty-prefix-directory")).toHaveLength(0);
	});

	test("broken symlink in worktree — flagged as error", async () => {
		const linkPath = `${featureWt.path}/.env`;
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: configFile({ symlinks: [".env"] }) },
			directories: [ROOT, ROOT_DIR, featureWt.path],
			brokenSymlinks: [linkPath],
		});
		const git = createFakeGit({ root: ROOT, worktrees: [mainWt, featureWt] });

		const report = expectOk(await runHealthCheck({ git, fs }));

		expect(report.healthy).toBe(false);
		expect(report.issues).toContainEqual({
			type: "broken-symlink",
			severity: "error",
			path: linkPath,
			worktreePath: featureWt.path,
		});
	});

	test("rebase in progress — flagged as error", async () => {
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: configFile() },
			directories: [ROOT, ROOT_DIR, featureWt.path],
		});
		const git = createFakeGit({
			root: ROOT,
			worktrees: [mainWt, featureWt],
			rebaseConflicts: new Set([featureWt.path]),
		});

		const report = expectOk(await runHealthCheck({ git, fs }));

		expect(report.healthy).toBe(false);
		expect(report.issues).toContainEqual({
			type: "rebase-in-progress",
			severity: "error",
			worktreePath: featureWt.path,
			branch: "feature",
		});
	});

	test("merge in progress — flagged as error", async () => {
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: configFile() },
			directories: [ROOT, ROOT_DIR, featureWt.path],
		});
		const git = createFakeGit({
			root: ROOT,
			worktrees: [mainWt, featureWt],
			mergeInProgress: new Set([featureWt.path]),
		});

		const report = expectOk(await runHealthCheck({ git, fs }));

		expect(report.healthy).toBe(false);
		expect(report.issues).toContainEqual({
			type: "merge-in-progress",
			severity: "error",
			worktreePath: featureWt.path,
			branch: "feature",
		});
	});

	test("dirty worktree — info severity, not error/warning", async () => {
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: configFile() },
			directories: [ROOT, ROOT_DIR, featureWt.path],
		});
		const git = createFakeGit({
			root: ROOT,
			worktrees: [mainWt, featureWt],
			dirtyWorktrees: new Set([featureWt.path]),
		});

		const report = expectOk(await runHealthCheck({ git, fs }));

		expect(report.issues).toContainEqual({
			type: "dirty-worktree",
			severity: "info",
			worktreePath: featureWt.path,
			branch: "feature",
		});
		expect(report.issues.every((i) => i.severity === "info")).toBe(true);
	});

	test("healthy is true when only info issues exist", async () => {
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: configFile() },
			directories: [ROOT, ROOT_DIR, featureWt.path],
		});
		const git = createFakeGit({
			root: ROOT,
			worktrees: [mainWt, featureWt],
			dirtyWorktrees: new Set([featureWt.path]),
		});

		const report = expectOk(await runHealthCheck({ git, fs }));

		expect(report.healthy).toBe(true);
	});

	test("config reference to missing file — flagged as error", async () => {
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: configFile({ copy: [".env.local"], symlinks: ["node_modules"] }) },
			directories: [ROOT, ROOT_DIR, featureWt.path],
		});
		const git = createFakeGit({ root: ROOT, worktrees: [mainWt, featureWt] });

		const report = expectOk(await runHealthCheck({ git, fs }));

		expect(report.healthy).toBe(false);
		expect(report.issues).toContainEqual({
			type: "config-ref-missing",
			severity: "error",
			path: ".env.local",
			field: "copy",
		});
		expect(report.issues).toContainEqual({
			type: "config-ref-missing",
			severity: "error",
			path: "node_modules",
			field: "symlinks",
		});
	});

	test("config reference to existing directory — NOT flagged (fs.exists handles dirs)", async () => {
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: configFile({ copy: ["backlog"], symlinks: [".local"] }) },
			directories: [ROOT, ROOT_DIR, featureWt.path, `${ROOT}/backlog`, `${ROOT}/.local`],
		});
		const git = createFakeGit({ root: ROOT, worktrees: [mainWt, featureWt] });

		const report = expectOk(await runHealthCheck({ git, fs }));

		expect(report.issues.filter((i) => i.type === "config-ref-missing")).toHaveLength(0);
	});

	test("glob patterns in config — not flagged as missing", async () => {
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: configFile({ copy: [".env*"], symlinks: ["build/**"] }) },
			directories: [ROOT, ROOT_DIR, featureWt.path],
		});
		const git = createFakeGit({ root: ROOT, worktrees: [mainWt, featureWt] });

		const report = expectOk(await runHealthCheck({ git, fs }));

		expect(report.issues.filter((i) => i.type === "config-ref-missing")).toHaveLength(0);
	});

	test("missing worktree directory — flagged as error", async () => {
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: configFile() },
			directories: [ROOT, ROOT_DIR],
		});
		const git = createFakeGit({ root: ROOT, worktrees: [mainWt, featureWt] });

		const report = expectOk(await runHealthCheck({ git, fs }));

		expect(report.healthy).toBe(false);
		expect(report.issues).toContainEqual({
			type: "missing-worktree-directory",
			severity: "error",
			worktreePath: featureWt.path,
			branch: "feature",
		});
	});

	test("multiple issues collected with correct severity", async () => {
		const emptyPrefix = `${ROOT_DIR}/abandoned`;
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: configFile({ copy: [".env"] }) },
			directories: [ROOT, ROOT_DIR, featureWt.path, emptyPrefix],
		});
		const git = createFakeGit({
			root: ROOT,
			worktrees: [mainWt, featureWt],
			dirtyWorktrees: new Set([featureWt.path]),
		});

		const report = expectOk(await runHealthCheck({ git, fs }));

		expect(report.healthy).toBe(false);
		const byType = new Map(report.issues.map((i) => [i.type, i.severity] as const));
		expect(byType.get("config-ref-missing")).toBe("error");
		expect(byType.get("empty-prefix-directory")).toBe("warning");
		expect(byType.get("dirty-worktree")).toBe("info");
	});
});
