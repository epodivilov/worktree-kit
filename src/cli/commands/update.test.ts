import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONFIG_FILENAME } from "../../domain/constants.ts";
import type { Worktree } from "../../domain/entities/worktree.ts";
import type { UiPort } from "../../domain/ports/ui-port.ts";
import type { Container } from "../../infrastructure/container.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit, type FakeGitOptions } from "../../test-utils/fake-git.ts";
import { updateCommand } from "./update.ts";

const ROOT = "/fake/project";

interface FakeUiLog {
	info: string[];
	success: string[];
	warn: string[];
	error: string[];
	outro: string[];
}

interface FakeUiOptions {
	nonInteractive?: boolean;
	/** Response for ui.confirm. */
	confirm?: boolean | symbol;
	/** Response for ui.select (value to return). */
	select?: string | symbol;
}

const CANCEL_SYMBOL = Symbol("cancel");

function createFakeUi(opts: FakeUiOptions = {}): {
	ui: UiPort;
	log: FakeUiLog;
	confirmMessages: string[];
	selectCalls: { message: string; values: string[] }[];
} {
	const log: FakeUiLog = { info: [], success: [], warn: [], error: [], outro: [] };
	const confirmMessages: string[] = [];
	const selectCalls: { message: string; values: string[] }[] = [];
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
			return { update() {}, complete() {}, fail() {}, stop() {} };
		},
		async text() {
			return "";
		},
		async confirm(options: { message: string }) {
			confirmMessages.push(options.message);
			return opts.confirm ?? true;
		},
		async select<T>(options: { message: string; options: Array<{ value: T; label: string }> }) {
			selectCalls.push({ message: options.message, values: options.options.map((o) => String(o.value)) });
			return (opts.select ?? options.options[0]?.value) as T;
		},
		async multiselect() {
			return [] as never;
		},
		isCancel(value: unknown): value is symbol {
			return value === CANCEL_SYMBOL;
		},
		cancel() {},
	} satisfies UiPort;
	return { ui, log, confirmMessages, selectCalls };
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

async function runUpdate(container: Container, args: Record<string, unknown>): Promise<number> {
	const cmd = updateCommand(container);
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

function upstreamScenario(
	configContent: string,
	gitOverrides: Partial<FakeGitOptions> = {},
): { fs: ReturnType<typeof createFakeFilesystem>; git: ReturnType<typeof createFakeGit> } {
	const fs = createFakeFilesystem({
		files: { [`${ROOT}/${CONFIG_FILENAME}`]: configContent },
		directories: [ROOT, `${ROOT}/.worktrees`],
	});
	const git = createFakeGit({
		root: ROOT,
		mainRoot: ROOT,
		worktrees: [mainWt],
		branches: ["main"],
		goneBranches: [],
		...gitOverrides,
	});
	return { fs, git };
}

async function readConfigUpstream(fs: ReturnType<typeof createFakeFilesystem>): Promise<unknown> {
	const read = await fs.readFile(`${ROOT}/${CONFIG_FILENAME}`);
	if (!read.success) throw new Error("config not written");
	return JSON.parse(read.data).upstream;
}

describe("update upstream auto-detection", () => {
	const CONFIG_NO_UPSTREAM = JSON.stringify({ rootDir: ".worktrees" }, null, 2);

	test("undefined + one non-origin remote + confirm yes → persists name and syncs from it", async () => {
		const mergeFFOnlyCalls: { worktreePath: string; branch: string; remote: string }[] = [];
		const { fs, git } = upstreamScenario(CONFIG_NO_UPSTREAM, {
			remotes: ["origin", "upstream"],
			mergeFFOnlyCalls,
		});
		const { ui, confirmMessages } = createFakeUi({ confirm: true });
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		expect(confirmMessages.some((m) => m.includes("upstream"))).toBe(true);
		expect(await readConfigUpstream(fs)).toBe("upstream");
		// The default branch was fast-forwarded from the picked remote.
		expect(mergeFFOnlyCalls.some((c) => c.branch === "main" && c.remote === "upstream")).toBe(true);
	});

	test("undefined + decline → persists false, no upstream sync", async () => {
		const mergeFFOnlyCalls: { worktreePath: string; branch: string; remote: string }[] = [];
		const { fs, git } = upstreamScenario(CONFIG_NO_UPSTREAM, {
			remotes: ["origin", "upstream"],
			mergeFFOnlyCalls,
		});
		const { ui } = createFakeUi({ confirm: false });
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		expect(await readConfigUpstream(fs)).toBe(false);
		// Fast-forward fell back to origin (no upstream remote used).
		expect(mergeFFOnlyCalls.every((c) => c.remote === "origin")).toBe(true);
	});

	test("upstream === false → no prompt, no detect, no upstream sync", async () => {
		const mergeFFOnlyCalls: { worktreePath: string; branch: string; remote: string }[] = [];
		const { fs, git } = upstreamScenario(JSON.stringify({ rootDir: ".worktrees", upstream: false }, null, 2), {
			remotes: ["origin", "upstream"],
			mergeFFOnlyCalls,
		});
		const { ui, confirmMessages, selectCalls } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		expect(confirmMessages).toEqual([]);
		expect(selectCalls).toEqual([]);
		expect(await readConfigUpstream(fs)).toBe(false);
		expect(mergeFFOnlyCalls.every((c) => c.remote === "origin")).toBe(true);
	});

	test("upstream string → no prompt, syncs from it", async () => {
		const mergeFFOnlyCalls: { worktreePath: string; branch: string; remote: string }[] = [];
		const { fs, git } = upstreamScenario(JSON.stringify({ rootDir: ".worktrees", upstream: "upstream" }, null, 2), {
			remotes: ["origin", "upstream"],
			mergeFFOnlyCalls,
		});
		const { ui, confirmMessages, selectCalls } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		expect(confirmMessages).toEqual([]);
		expect(selectCalls).toEqual([]);
		expect(mergeFFOnlyCalls.some((c) => c.branch === "main" && c.remote === "upstream")).toBe(true);
	});

	test("non-interactive + undefined → no prompt, no persist", async () => {
		const { fs, git } = upstreamScenario(CONFIG_NO_UPSTREAM, { remotes: ["origin", "upstream"] });
		const { ui, confirmMessages, selectCalls } = createFakeUi({ nonInteractive: true });
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false, cleanup: true });

		expect(code).toBe(0);
		expect(confirmMessages).toEqual([]);
		expect(selectCalls).toEqual([]);
		expect(await readConfigUpstream(fs)).toBeUndefined();
	});

	test("--dry-run + undefined → no prompt, no persist", async () => {
		const { fs, git } = upstreamScenario(CONFIG_NO_UPSTREAM, { remotes: ["origin", "upstream"] });
		const { ui, confirmMessages, selectCalls } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": true });

		expect(code).toBe(0);
		expect(confirmMessages).toEqual([]);
		expect(selectCalls).toEqual([]);
		expect(await readConfigUpstream(fs)).toBeUndefined();
	});
});

describe("update --cleanup — dirty worktree", () => {
	test("dirty gone branch is hidden from cleanup and reported as kept", async () => {
		const { fs, git } = dirtyGoneScenario();
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false, cleanup: true });

		expect(code).toBe(0);
		// The branch isn't cleaned up (worktree is dirty) — surface it as kept.
		expect(log.info.some((m) => m.includes("kept"))).toBe(true);
		// And no dirty-skipped warning fires because cleanup didn't run for it.
		expect(log.warn.some((m) => m.includes("uncommitted changes"))).toBe(false);
	});
});

describe("update — empty stale branches", () => {
	test("gone branch with ahead=0 + active worktree → not prompted, kept info shown", async () => {
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
			mergedBranches: [],
			commitCountMap: new Map([["main..feature", 0]]),
		});
		const { ui, log, confirmMessages } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		// "empty" branches are no longer treated as positively merged in `wt update`.
		expect(confirmMessages).toEqual([]);
		expect(log.info.some((m) => m.includes("kept"))).toBe(true);
		expect(log.outro).toEqual(["Done!"]);
	});
});

describe("update — unmergeable gone branches", () => {
	test("gone branch with active worktree + unmerged → no prompt, kept info, outro Done!", async () => {
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
			mergedBranches: [],
			commitCountMap: new Map([["main..feature", 2]]),
			revListMap: new Map([
				["main..feature", ["sha1", "sha2"]],
				["feature..main", []],
			]),
			revListCherryPickMap: new Map([["main...feature", ["sha1", "sha2"]]]),
			mergeBaseMap: new Map([["main:feature", "merge-base"]]),
		});
		const { ui, log, confirmMessages } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		expect(confirmMessages).toEqual([]);
		expect(log.info.some((m) => m.includes("kept"))).toBe(true);
		expect(log.outro).toEqual(["Done!"]);
	});
});
