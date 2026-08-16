import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONFIG_FILENAME } from "../../domain/constants.ts";
import type { Worktree } from "../../domain/entities/worktree.ts";
import type { UiPort } from "../../domain/ports/ui-port.ts";
import type { Container } from "../../infrastructure/container.ts";
import { expectOk } from "../../test-utils/assertions.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit, type FakeGitOptions } from "../../test-utils/fake-git.ts";
import { cleanupCommand } from "./cleanup.ts";

const ROOT = "/fake/project";

interface FakeUiLog {
	info: string[];
	success: string[];
	warn: string[];
	error: string[];
	outro: string[];
}

function createFakeUi(opts: { nonInteractive?: boolean; confirm?: boolean } = {}): { ui: UiPort; log: FakeUiLog } {
	const log: FakeUiLog = { info: [], success: [], warn: [], error: [], outro: [] };
	const ui = {
		nonInteractive: opts.nonInteractive ?? false,
		intro() {},
		outro(message: string) {
			log.outro.push(message);
		},
		info(message: string) {
			log.info.push(message);
		},
		success(message: string) {
			log.success.push(message);
		},
		warn(message: string) {
			log.warn.push(message);
		},
		error(message: string) {
			log.error.push(message);
		},
		async spinner<T>(_message: string, fn: () => Promise<T>): Promise<T> {
			return fn();
		},
		createSpinner() {
			return { start() {}, message() {}, stop() {} };
		},
		createMultiSpinner() {
			return { update() {}, complete() {}, fail() {}, skip() {}, stop() {} };
		},
		async text() {
			return "";
		},
		async confirm() {
			return opts.confirm ?? true;
		},
		async select() {
			return undefined as never;
		},
		async multiselect() {
			return [] as never;
		},
		isCancel(_value: unknown): _value is symbol {
			return false;
		},
		cancel() {},
	} satisfies UiPort;
	return { ui, log };
}

function buildContainer(
	ui: UiPort,
	git: ReturnType<typeof createFakeGit>,
	fs: ReturnType<typeof createFakeFilesystem>,
): Container {
	return {
		ui,
		git,
		fs,
		shell: {} as never,
		logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
	};
}

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

let exitSpy: typeof process.exit;
let recordedExit: number | null;

beforeEach(() => {
	exitSpy = process.exit;
	recordedExit = null;
	process.exit = ((code?: number): never => {
		if (recordedExit === null) recordedExit = code ?? 0;
		throw new ExitSignal(code ?? 0);
	}) as typeof process.exit;
});

afterEach(() => {
	process.exit = exitSpy;
});

async function runCleanup(container: Container, args: Record<string, unknown>): Promise<number> {
	const cmd = cleanupCommand(container);
	const run = cmd.run as (ctx: { args: Record<string, unknown>; cmd: unknown; rawArgs: string[] }) => Promise<void>;
	try {
		await run({ args, cmd, rawArgs: [] });
		return recordedExit ?? 0;
	} catch (err) {
		if (err instanceof ExitSignal) return recordedExit ?? err.code;
		throw err;
	}
}

const mainWt: Worktree = { path: ROOT, branch: "main", head: "aaa", isMain: true, isPrunable: false };
const featureWt: Worktree = {
	path: `${ROOT}/.worktrees/feature`,
	branch: "feature",
	head: "bbb",
	isMain: false,
	isPrunable: false,
};

function dirtyGoneScenario(gitOverrides: Partial<FakeGitOptions> = {}) {
	const fs = createFakeFilesystem({
		files: { [`${ROOT}/${CONFIG_FILENAME}`]: JSON.stringify({ rootDir: ".worktrees" }) },
		directories: [ROOT, `${ROOT}/.worktrees`, featureWt.path],
	});
	const git = createFakeGit({
		root: ROOT,
		mainRoot: ROOT,
		worktrees: [mainWt, featureWt],
		branches: ["main", "feature"],
		goneBranches: ["feature"],
		mergedBranches: ["feature"],
		dirtyWorktrees: new Set([featureWt.path]),
		...gitOverrides,
	});
	return { fs, git };
}

describe("cleanup — dry-run preview matches real run", () => {
	function mixedScenario() {
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: JSON.stringify({ rootDir: ".worktrees" }) },
			directories: [ROOT, `${ROOT}/.worktrees`],
		});
		const git = createFakeGit({
			root: ROOT,
			mainRoot: ROOT,
			worktrees: [mainWt],
			branches: ["main", "merged-one", "unmerged-one"],
			goneBranches: ["merged-one", "unmerged-one"],
			mergedBranches: ["merged-one"],
			commitCountMap: new Map([
				["main..merged-one", 0],
				["main..unmerged-one", 2],
			]),
			revListMap: new Map([["main..unmerged-one", ["sha1", "sha2"]]]),
			revListCherryPickMap: new Map([["main...unmerged-one", ["sha1", "sha2"]]]),
			mergeBaseMap: new Map([["main:unmerged-one", "merge-base"]]),
		});
		return { fs, git };
	}

	test("dry-run counts and lists only real candidates, skipped shown with reason", async () => {
		const { fs, git } = mixedScenario();
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runCleanup(container, { force: false, yes: false, "dry-run": true });

		expect(code).toBe(0);
		expect(log.info.some((m) => m.includes("merged-one"))).toBe(true);
		expect(log.info.some((m) => m.includes("unmerged-one"))).toBe(false);
		expect(log.warn.some((m) => m.includes("unmerged-one") && m.includes("--force"))).toBe(true);
		expect(expectOk(await git.branchExists("merged-one"))).toBe(true);
		expect(expectOk(await git.branchExists("unmerged-one"))).toBe(true);
	});

	test("real run deletes exactly what the preview listed", async () => {
		const { fs, git } = mixedScenario();
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runCleanup(container, { force: false, yes: true, "dry-run": false });

		expect(code).toBe(0);
		expect(expectOk(await git.branchExists("merged-one"))).toBe(false);
		expect(expectOk(await git.branchExists("unmerged-one"))).toBe(true);
		// The skipped branch is reported once (discovery), not re-reported by the execute pass.
		expect(log.warn.filter((m) => m.includes("unmerged-one")).length).toBe(1);
	});
});

describe("cleanup — dirty worktree warning", () => {
	test("skipped-dirty warning names the path and suggests stash / --force", async () => {
		const { fs, git } = dirtyGoneScenario();
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runCleanup(container, { force: false, yes: true, "dry-run": false });

		const warning = log.warn.find((m) => m.includes("feature") && m.includes("uncommitted changes"));
		expect(warning).toBeDefined();
		expect(warning).toContain(".worktrees/feature");
		expect(warning).toContain("stash");
		expect(warning).toContain("--force");
		// Within `wt cleanup` the suggestion is to re-run, not to invoke `wt cleanup` again.
		expect(warning).not.toContain("wt cleanup");
		expect(code).toBe(0);
	});
});

describe("cleanup — locked worktrees reported as a skipped group", () => {
	const feature2Wt: Worktree = {
		path: `${ROOT}/.worktrees/feature2`,
		branch: "feature2",
		head: "ccc",
		isMain: false,
		isPrunable: false,
	};

	// R2: one branch cleaned, one worktree locked → the lock does not count toward
	// the error tally and the command still exits success (never partial/failure).
	test("R2: one cleaned + one locked — exits success, no red error", async () => {
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: JSON.stringify({ rootDir: ".worktrees" }) },
			directories: [ROOT, `${ROOT}/.worktrees`, featureWt.path, feature2Wt.path],
		});
		const git = createFakeGit({
			root: ROOT,
			mainRoot: ROOT,
			worktrees: [mainWt, featureWt, feature2Wt],
			branches: ["main", "feature", "feature2"],
			goneBranches: ["feature", "feature2"],
			mergedBranches: ["feature", "feature2"],
			commitCountMap: new Map([
				["main..feature", 0],
				["main..feature2", 0],
			]),
			lockedWorktrees: new Map([[feature2Wt.path, "kepler:task:abc"]]),
		});
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runCleanup(container, { force: false, yes: true, "dry-run": false });

		// Success exit — a lock alone never flips the exit code.
		expect(code).toBe(0);
		// The removable branch was cleaned.
		expect(log.success).toContain("feature — worktree and branch removed");
		// The lock produced no red error.
		expect(log.error).toHaveLength(0);
		// The locked one lands in the warn group with its unlock command.
		expect(log.warn.some((m) => m.includes(`git worktree unlock "${feature2Wt.path}"`))).toBe(true);
	});

	// R3: two locked worktrees → exactly one warn group with a count header, one
	// line per worktree (name + unlock command), and a re-run hint for `wt cleanup`.
	test("R3: two locked worktrees — single warn group (count, names, unlock commands, re-run hint)", async () => {
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: JSON.stringify({ rootDir: ".worktrees" }) },
			directories: [ROOT, `${ROOT}/.worktrees`, featureWt.path, feature2Wt.path],
		});
		const git = createFakeGit({
			root: ROOT,
			mainRoot: ROOT,
			worktrees: [mainWt, featureWt, feature2Wt],
			branches: ["main", "feature", "feature2"],
			goneBranches: ["feature", "feature2"],
			mergedBranches: ["feature", "feature2"],
			commitCountMap: new Map([
				["main..feature", 0],
				["main..feature2", 0],
			]),
			// One lock carries an empty reason — the per-line text must not depend on it.
			lockedWorktrees: new Map([
				[featureWt.path, ""],
				[feature2Wt.path, "kepler:task:xyz"],
			]),
		});
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runCleanup(container, { force: false, yes: true, "dry-run": false });

		// Exactly one warn group carries the unlock commands.
		const groups = log.warn.filter((m) => m.includes("git worktree unlock"));
		expect(groups).toHaveLength(1);
		const group = groups[0] as string;

		// Header states the count.
		expect(group).toContain("2 worktrees skipped");
		// One line per worktree: its name + copy-paste unlock command.
		expect(group).toContain("feature");
		expect(group).toContain(`git worktree unlock "${featureWt.path}"`);
		expect(group).toContain("feature2");
		expect(group).toContain(`git worktree unlock "${feature2Wt.path}"`);
		// Re-run hint targets `wt cleanup`.
		expect(group).toContain("re-run wt cleanup");
		// Never a red error for a lock.
		expect(log.error).toHaveLength(0);
		expect(code).toBe(0);
	});

	// R4: skipped-dirty and skipped-unmerged keep their existing rendering; only the
	// locked worktree joins the warn group.
	test("R4: dirty + unmerged + locked — only the locked one joins the warn group", async () => {
		const lockedWt: Worktree = {
			path: `${ROOT}/.worktrees/locked-branch`,
			branch: "locked-branch",
			head: "l11",
			isMain: false,
			isPrunable: false,
		};
		const dirtyWt: Worktree = {
			path: `${ROOT}/.worktrees/dirty-branch`,
			branch: "dirty-branch",
			head: "d11",
			isMain: false,
			isPrunable: false,
		};
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: JSON.stringify({ rootDir: ".worktrees" }) },
			directories: [ROOT, `${ROOT}/.worktrees`, lockedWt.path, dirtyWt.path],
		});
		const git = createFakeGit({
			root: ROOT,
			mainRoot: ROOT,
			worktrees: [mainWt, lockedWt, dirtyWt],
			branches: ["main", "locked-branch", "dirty-branch", "unmerged-branch"],
			goneBranches: ["locked-branch", "dirty-branch", "unmerged-branch"],
			mergedBranches: ["locked-branch", "dirty-branch"],
			dirtyWorktrees: new Set([dirtyWt.path]),
			lockedWorktrees: new Map([[lockedWt.path, "kepler:task:abc"]]),
			commitCountMap: new Map([
				["main..locked-branch", 0],
				["main..dirty-branch", 0],
				["main..unmerged-branch", 2],
			]),
			revListMap: new Map([["main..unmerged-branch", ["sha1", "sha2"]]]),
			revListCherryPickMap: new Map([["main...unmerged-branch", ["sha1", "sha2"]]]),
			mergeBaseMap: new Map([["main:unmerged-branch", "merge-base"]]),
		});
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runCleanup(container, { force: false, yes: true, "dry-run": false });

		// skipped-dirty renders as today.
		expect(log.warn.some((m) => m.includes("dirty-branch") && m.includes("uncommitted changes"))).toBe(true);
		// skipped-unmerged renders as today.
		expect(log.warn.some((m) => m.includes("unmerged-branch") && m.includes("not fully merged"))).toBe(true);

		// Exactly one warn group, and it carries only the locked worktree.
		const groups = log.warn.filter((m) => m.includes("git worktree unlock"));
		expect(groups).toHaveLength(1);
		const group = groups[0] as string;
		expect(group).toContain(`git worktree unlock "${lockedWt.path}"`);
		expect(group).not.toContain("dirty-branch");
		expect(group).not.toContain("unmerged-branch");

		expect(log.error).toHaveLength(0);
		expect(code).toBe(0);
	});
});
