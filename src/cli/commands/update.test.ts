import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONFIG_FILENAME } from "../../domain/constants.ts";
import type { Worktree } from "../../domain/entities/worktree.ts";
import type { UiPort } from "../../domain/ports/ui-port.ts";
import type { Container } from "../../infrastructure/container.ts";
import { expectOk } from "../../test-utils/assertions.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit, type FakeGitOptions, type FakeRebaseCall } from "../../test-utils/fake-git.ts";
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

/**
 * Records how the CLI drives `createMultiSpinner`. `update` is a no-op that only
 * records the call (mirroring the non-TTY adapter, where `update` produces no
 * output), so `terminals` holds exactly the one-line-per-worktree results a
 * non-TTY run would print (R2).
 */
interface MultiSpinnerCapture {
	keys: string[];
	terminals: { type: "complete" | "fail"; key: string; message: string }[];
	updates: { key: string; message: string }[];
}

/**
 * Records how the CLI drives single-line spinners (`createSpinner`) — shared across
 * every instance (the WTK-67 phase spinner, the WTK-69 classification spinner, and
 * the cleanup spinner). `starts` holds every label passed to `start`; `stops` holds
 * every `stop` message (one entry per stop call); `messages` holds every `.message()`
 * text (one entry per call, in order — used to assert the WTK-69 "X of N" counter).
 * The shared ordered `calls` log (returned alongside) records spinner start/stop
 * (each stop labeled with the start message of its own instance, so distinct
 * spinners never collide), spinner message, multi-spinner, info, and confirm events
 * across the run — used to assert both "stopped before the multi-spinner list" (WTK-67
 * R2) and "the classification spinner stopped before the gone-branch list / confirm
 * prompt" (WTK-69 R3).
 */
interface SpinnerCapture {
	starts: string[];
	stops: (string | undefined)[];
	messages: string[];
}

const CANCEL_SYMBOL = Symbol("cancel");

function createFakeUi(opts: FakeUiOptions = {}): {
	ui: UiPort;
	log: FakeUiLog;
	confirmMessages: string[];
	selectCalls: { message: string; values: string[] }[];
	multiSpinner: MultiSpinnerCapture;
	spinner: SpinnerCapture;
	calls: string[];
} {
	const log: FakeUiLog = { info: [], success: [], warn: [], error: [], outro: [] };
	const confirmMessages: string[] = [];
	const selectCalls: { message: string; values: string[] }[] = [];
	const multiSpinner: MultiSpinnerCapture = { keys: [], terminals: [], updates: [] };
	const spinner: SpinnerCapture = { starts: [], stops: [], messages: [] };
	const calls: string[] = [];
	const ui = {
		nonInteractive: opts.nonInteractive ?? false,
		intro() {},
		outro(message: string) {
			log.outro.push(message);
		},
		info(message: string) {
			log.info.push(message);
			calls.push(`info:${message}`);
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
			// Tracks this instance's own start label so its `stop` entry in the shared
			// `calls` log is self-identifying — needed because several distinct spinner
			// instances (phase, classification, cleanup) share one `SpinnerCapture`.
			let label = "";
			return {
				start(message: string) {
					label = message;
					spinner.starts.push(message);
					calls.push(`spinner:start:${message}`);
				},
				message(message: string) {
					spinner.messages.push(message);
					calls.push(`spinner:message:${message}`);
				},
				stop(message?: string) {
					spinner.stops.push(message);
					calls.push(`spinner:stop:${label}`);
				},
			};
		},
		createMultiSpinner(keys: string[]) {
			multiSpinner.keys = [...keys];
			calls.push("multiSpinner:create");
			return {
				update(key: string, message: string) {
					multiSpinner.updates.push({ key, message });
				},
				complete(key: string, message: string) {
					multiSpinner.terminals.push({ type: "complete", key, message });
				},
				fail(key: string, message: string) {
					multiSpinner.terminals.push({ type: "fail", key, message });
				},
				skip() {},
				stop() {},
			};
		},
		async text() {
			return "";
		},
		async confirm(options: { message: string }) {
			confirmMessages.push(options.message);
			calls.push(`confirm:${options.message}`);
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
	return { ui, log, confirmMessages, selectCalls, multiSpinner, spinner, calls };
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

describe("update --cleanup — allow-list parity with prompt", () => {
	function mixedGoneScenario() {
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: JSON.stringify({ rootDir: ".worktrees" }) },
			directories: [ROOT, `${ROOT}/.worktrees`],
		});
		const git = createFakeGit({
			root: ROOT,
			mainRoot: ROOT,
			worktrees: [mainWt],
			branches: ["main", "merged-one", "empty-one"],
			goneBranches: ["merged-one", "empty-one"],
			mergedBranches: ["merged-one"],
			// merged-one: 2 commits ahead, all cherry-picked into main → "merged".
			// empty-one: 0 commits ahead, no merge proof → "empty" (kept by `wt update`).
			commitCountMap: new Map([
				["main..merged-one", 2],
				["main..empty-one", 0],
			]),
			revListMap: new Map([["main..merged-one", ["sha1", "sha2"]]]),
			revListCherryPickMap: new Map([["main...merged-one", []]]),
		});
		return { fs, git };
	}

	test("only positively-merged branches are deleted, empty ones survive", async () => {
		const { fs, git } = mixedGoneScenario();
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false, cleanup: true });

		expect(code).toBe(0);
		expect(expectOk(await git.branchExists("merged-one"))).toBe(false);
		expect(expectOk(await git.branchExists("empty-one"))).toBe(true);
		expect(log.success.some((m) => m.includes("merged-one"))).toBe(true);
		// Auto-cleanup reports kept branches as a count, never by deleting them.
		expect(log.info.some((m) => m.includes("1 branch(es) kept"))).toBe(true);
		// The kept branch must not appear in any cleanup output.
		const allLines = [...log.success, ...log.warn, ...log.error];
		expect(allLines.some((m) => m.includes("empty-one"))).toBe(false);
	});

	test("dry-run preview lists only branches the prompt counted", async () => {
		const { fs, git } = mixedGoneScenario();
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": true, cleanup: true });

		expect(code).toBe(0);
		const previewLines = log.info.filter((m) => m.includes("would be cleaned up"));
		expect(previewLines).toHaveLength(1);
		expect(previewLines[0]).toContain("merged-one");
		expect(expectOk(await git.branchExists("empty-one"))).toBe(true);
		expect(expectOk(await git.branchExists("merged-one"))).toBe(true);
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

describe("update — dry-run default-branch preview", () => {
	const CONFIG_NO_UPSTREAM = JSON.stringify({ rootDir: ".worktrees" }, null, 2);

	test("behind by N>1 → previews the plural 'would be advanced by N commits' line", async () => {
		// Dry run resolves the behind-count from `main@{u}` (no upstream configured).
		const { fs, git } = upstreamScenario(CONFIG_NO_UPSTREAM, {
			commitCountMap: new Map([["main..main@{u}", 3]]),
		});
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": true });

		expect(code).toBe(0);
		expect(log.info).toContain("main would be advanced by 3 commits");
	});

	test("behind by 0 → previews the 'is already up to date' line", async () => {
		const { fs, git } = upstreamScenario(CONFIG_NO_UPSTREAM, {
			commitCountMap: new Map([["main..main@{u}", 0]]),
		});
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": true });

		expect(code).toBe(0);
		expect(log.info).toContain("main is already up to date");
	});

	test("count unavailable → previews the numberless 'would be advanced' line", async () => {
		// No commitCountMap entry → getCommitCount fails → the count is omitted.
		const { fs, git } = upstreamScenario(CONFIG_NO_UPSTREAM);
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": true });

		expect(code).toBe(0);
		expect(log.info).toContain("main would be advanced");
		// The numberless variant must not leak a commit count.
		expect(log.info.some((m) => m.includes("advanced by"))).toBe(false);
	});
});

describe("update — default-branch divergence rendering (WTK-61)", () => {
	const CONFIG_NO_UPSTREAM_OPTOUT = JSON.stringify({ rootDir: ".worktrees", upstream: false }, null, 2);

	test("R7: diverged + fully-merged default branch → distinct 'reset to <remote>/<branch>' line", async () => {
		// mergeFFOnly fails (diverged); every local commit is cherry-picked upstream → safe reset.
		const { fs, git } = upstreamScenario(CONFIG_NO_UPSTREAM_OPTOUT, {
			mergeFFOnlyFails: true,
			commitCountMap: new Map([["origin/main..main", 1]]),
			revListMap: new Map([["origin/main..main", ["c1"]]]),
			revListCherryPickMap: new Map([["origin/main...main", []]]),
		});
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		expect(log.success.some((m) => m.includes("reset to origin/main"))).toBe(true);
	});

	test("R7: genuinely diverged default branch → warning line, run still succeeds", async () => {
		const { fs, git } = upstreamScenario(CONFIG_NO_UPSTREAM_OPTOUT, {
			mergeFFOnlyFails: true,
			commitCountMap: new Map([["origin/main..main", 2]]),
			revListMap: new Map([["origin/main..main", ["c2", "c1"]]]),
			revListCherryPickMap: new Map([["origin/main...main", ["c2", "c1"]]]),
		});
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		expect(log.warn.some((m) => m.includes("diverged"))).toBe(true);
	});
});

describe("update — per-worktree progress (WTK-58)", () => {
	// main ← a (conflicts), a ← b (skipped as a's descendant), main ← c (rebased).
	function stackScenario(gitOverrides: Partial<FakeGitOptions> = {}) {
		const a: Worktree = { path: `${ROOT}/.worktrees/a`, branch: "a", head: "a1", isMain: false, isPrunable: false };
		const b: Worktree = { path: `${ROOT}/.worktrees/b`, branch: "b", head: "b1", isMain: false, isPrunable: false };
		const c: Worktree = { path: `${ROOT}/.worktrees/c`, branch: "c", head: "c1", isMain: false, isPrunable: false };
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: JSON.stringify({ rootDir: ".worktrees", upstream: false }) },
			directories: [ROOT, `${ROOT}/.worktrees`, a.path, b.path, c.path],
		});
		const git = createFakeGit({
			root: ROOT,
			mainRoot: ROOT,
			worktrees: [mainWt, a, b, c],
			branches: ["main", "a", "b", "c"],
			goneBranches: [],
			mergeBaseMap: new Map([
				["a:main", "aaa"],
				["main:a", "aaa"],
				["b:main", "aaa"],
				["main:b", "aaa"],
				["b:a", "eee"],
				["a:b", "eee"],
				["c:main", "aaa"],
				["main:c", "aaa"],
			]),
			commitCountMap: new Map([
				["aaa..a", 2],
				["aaa..b", 4],
				["eee..b", 2],
				["aaa..c", 2],
				["eee..a", 0],
			]),
			...gitOverrides,
		});
		return { fs, git };
	}

	test("R2: one terminal line per targeted worktree, skipped children included, no ANSI", async () => {
		const { fs, git } = stackScenario({ rebaseConflicts: new Set([`${ROOT}/.worktrees/a`]) });
		const { ui, multiSpinner } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		// The spinner is seeded with every targeted worktree, including the child
		// that will be skipped because its parent conflicted.
		expect([...multiSpinner.keys].sort()).toEqual(["a", "b", "c"]);
		// Exactly one terminal (complete/fail) line per targeted worktree.
		expect(multiSpinner.terminals).toHaveLength(3);
		expect(new Set(multiSpinner.terminals.map((t) => t.key))).toEqual(new Set(["a", "b", "c"]));
		// No live-render/ANSI escape sequences leak into the terminal messages.
		for (const t of multiSpinner.terminals) {
			expect(t.message).not.toContain("\x1b");
		}
		const lineFor = (key: string) => multiSpinner.terminals.find((t) => t.key === key);
		expect(lineFor("a")?.type).toBe("fail");
		expect(lineFor("a")?.message).toContain("conflict");
		expect(lineFor("c")?.type).toBe("complete");
		expect(lineFor("c")?.message).toContain("rebased onto main");
		expect(lineFor("b")?.type).toBe("fail");
		expect(lineFor("b")?.message).toContain("parent a failed");
	});

	test("R7: dry-run reports would-be-rebased per worktree and performs no rebase", async () => {
		const rebaseCalls: FakeRebaseCall[] = [];
		const mergeFFOnlyCalls: { worktreePath: string; branch: string; remote: string }[] = [];
		const { fs, git } = stackScenario({ rebaseCalls, mergeFFOnlyCalls });
		const { ui, multiSpinner } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": true });

		expect(code).toBe(0);
		// Dry run makes no repository changes.
		expect(rebaseCalls).toEqual([]);
		expect(mergeFFOnlyCalls).toEqual([]);
		expect(multiSpinner.terminals).toHaveLength(3);
		expect(multiSpinner.terminals.every((t) => t.type === "complete")).toBe(true);
		expect(multiSpinner.terminals.every((t) => t.message.includes("would be rebased"))).toBe(true);
	});
});

describe("update — --jobs validation (WTK-58)", () => {
	function rebaseScenario(gitOverrides: Partial<FakeGitOptions> = {}) {
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: JSON.stringify({ rootDir: ".worktrees", upstream: false }) },
			directories: [ROOT, `${ROOT}/.worktrees`, featureWt.path],
		});
		const git = createFakeGit({
			root: ROOT,
			mainRoot: ROOT,
			worktrees: [mainWt, featureWt],
			branches: ["main", "feature"],
			goneBranches: [],
			...gitOverrides,
		});
		return { fs, git };
	}

	test("R4b: --jobs abc is rejected as an argument error and runs no rebase", async () => {
		const rebaseCalls: FakeRebaseCall[] = [];
		const { fs, git } = rebaseScenario({ rebaseCalls });
		const { ui } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false, jobs: "abc" });

		expect(code).not.toBe(0);
		expect(rebaseCalls).toEqual([]);
	});

	test("R4b: --jobs 0 is rejected as an argument error and runs no rebase", async () => {
		const rebaseCalls: FakeRebaseCall[] = [];
		const { fs, git } = rebaseScenario({ rebaseCalls });
		const { ui } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false, jobs: "0" });

		expect(code).not.toBe(0);
		expect(rebaseCalls).toEqual([]);
	});

	test("--jobs 2 is accepted", async () => {
		const rebaseCalls: FakeRebaseCall[] = [];
		const { fs, git } = rebaseScenario({ rebaseCalls });
		const { ui } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false, jobs: "2" });

		expect(code).toBe(0);
		expect(rebaseCalls.map((c) => c.worktreePath)).toEqual([featureWt.path]);
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

describe("update — fetch/analysis phase spinner (WTK-67)", () => {
	// upstream opt-out keeps the first-run prompt out of the way so the run is
	// non-interactive from the CLI's point of view (the spinner still starts after
	// the prompt gate, per the spec).
	const CONFIG_OPTOUT = JSON.stringify({ rootDir: ".worktrees", upstream: false }, null, 2);
	const PHASE_LABEL = "Fetching and analyzing worktrees...";

	function phaseScenario(gitOverrides: Partial<FakeGitOptions> = {}) {
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: CONFIG_OPTOUT },
			directories: [ROOT, `${ROOT}/.worktrees`, featureWt.path],
		});
		const git = createFakeGit({
			root: ROOT,
			mainRoot: ROOT,
			worktrees: [mainWt, featureWt],
			branches: ["main", "feature"],
			goneBranches: [],
			...gitOverrides,
		});
		return { fs, git };
	}

	test("R1: starts the phase spinner once with the fetch/analysis label", async () => {
		const { fs, git } = phaseScenario();
		const { ui, spinner } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		expect(spinner.starts).toEqual([PHASE_LABEL]);
	});

	test("R1: the phase spinner also starts on a --dry-run run", async () => {
		const { fs, git } = phaseScenario();
		const { ui, spinner } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": true });

		expect(code).toBe(0);
		expect(spinner.starts).toEqual([PHASE_LABEL]);
	});

	test("R2: stops the phase spinner before the multi-spinner list is created", async () => {
		const { fs, git } = phaseScenario();
		const { ui, calls } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		const stopIdx = calls.findIndex((c) => c.startsWith("spinner:stop:"));
		const listIdx = calls.indexOf("multiSpinner:create");
		expect(stopIdx).toBeGreaterThanOrEqual(0);
		expect(listIdx).toBeGreaterThanOrEqual(0);
		// The phase spinner must be stopped before the multi-spinner starts drawing,
		// so the two TTY renderers never interleave.
		expect(stopIdx).toBeLessThan(listIdx);
	});

	test("R3: stops the phase spinner when the fetch fails before the list is created", async () => {
		// git.fetchPrune() fails, so updateWorktrees returns an error before `begin`
		// ever fires — the only path where stopping solely inside `begin` would leave
		// the spinner spinning.
		const { fs, git } = phaseScenario({ fetchFails: true });
		const { ui, spinner, multiSpinner } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).not.toBe(0);
		// `begin` never fired, so no multi-spinner was created…
		expect(multiSpinner.keys).toEqual([]);
		// …yet the phase spinner was still stopped rather than left running.
		expect(spinner.stops).toHaveLength(1);
	});

	test("R4 (empty target set): begin([]) stops the phase spinner exactly once", async () => {
		// Only the default branch exists, so there is no feature worktree to update:
		// `begin` fires with an empty array. The phase spinner is stopped there and the
		// post-return fallback must not double-stop it.
		const { fs, git } = phaseScenario({ worktrees: [mainWt], branches: ["main"] });
		const { ui, spinner } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		expect(spinner.stops).toHaveLength(1);
	});

	test("R4 (normal path): the phase spinner is stopped exactly once", async () => {
		const { fs, git } = phaseScenario();
		const { ui, spinner } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		expect(spinner.stops).toHaveLength(1);
	});
});

describe("update — gone-branch classification spinner (WTK-69)", () => {
	// The classification loop runs after the WTK-67 phase spinner has already
	// stopped (inside `begin`), so opting out of upstream sync here just keeps the
	// scenario free of the interactive upstream prompt — it isn't needed to avoid
	// overlap with the phase spinner.
	const CONFIG_OPTOUT = JSON.stringify({ rootDir: ".worktrees", upstream: false }, null, 2);
	// Every classification-spinner label starts with this — distinguishes it from
	// the WTK-67 phase spinner ("Fetching and analyzing worktrees...") and the
	// cleanup spinner ("Cleaning up stale branches...") in the shared capture.
	const CLASSIFY_LABEL_PREFIX = "Classifying gone branches";

	// Two stale branches: merged-one is positively merged (proof via patch-id),
	// empty-one has zero commits ahead (no merge proof, kept). Both still go
	// through the classification loop — only rebase-merged branches skip it.
	function classifyScenario(gitOverrides: Partial<FakeGitOptions> = {}) {
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: CONFIG_OPTOUT },
			directories: [ROOT, `${ROOT}/.worktrees`],
		});
		const git = createFakeGit({
			root: ROOT,
			mainRoot: ROOT,
			worktrees: [mainWt],
			branches: ["main", "merged-one", "empty-one"],
			goneBranches: ["merged-one", "empty-one"],
			mergedBranches: ["merged-one"],
			commitCountMap: new Map([
				["main..merged-one", 2],
				["main..empty-one", 0],
			]),
			revListMap: new Map([["main..merged-one", ["sha1", "sha2"]]]),
			revListCherryPickMap: new Map([["main...merged-one", []]]),
			...gitOverrides,
		});
		return { fs, git };
	}

	test("R1: starts and stops the classification spinner exactly once", async () => {
		const { fs, git } = classifyScenario();
		const { ui, calls } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		const starts = calls.filter((c) => c.startsWith(`spinner:start:${CLASSIFY_LABEL_PREFIX}`));
		const stops = calls.filter((c) => c.startsWith(`spinner:stop:${CLASSIFY_LABEL_PREFIX}`));
		expect(starts).toHaveLength(1);
		expect(stops).toHaveLength(1);
	});

	test("R2: message updates show an advancing X of N counter, ending at N of N", async () => {
		const { fs, git } = classifyScenario();
		const { ui, spinner } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		const classifyMessages = spinner.messages.filter((m) => m.startsWith(CLASSIFY_LABEL_PREFIX));
		// Two stale branches (merged-one, empty-one) → two per-iteration updates.
		expect(classifyMessages).toHaveLength(2);
		expect(classifyMessages[0]).toContain("1 of 2");
		expect(classifyMessages[1]).toContain("2 of 2");
	});

	test("R3: classification spinner stops before the gone-branch list and the confirm prompt", async () => {
		const { fs, git } = classifyScenario();
		const { ui, calls } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		const stopIdx = calls.findIndex((c) => c.startsWith(`spinner:stop:${CLASSIFY_LABEL_PREFIX}`));
		const infoIdx = calls.indexOf("info:Branches with gone remotes:");
		const confirmIdx = calls.findIndex((c) => c.startsWith("confirm:"));
		expect(stopIdx).toBeGreaterThanOrEqual(0);
		expect(infoIdx).toBeGreaterThan(stopIdx);
		expect(confirmIdx).toBeGreaterThan(stopIdx);
	});

	test("R4a: no stale branches and nothing rebase-merged → early-return path never reaches the classification block", async () => {
		// goneBranches: [] and mergedBranches: [] together mean staleBranches and
		// rebaseMerged are BOTH empty, so this run exits via the pre-existing
		// `staleBranches.length === 0 && rebaseMerged.length === 0` guard before the
		// classification block even runs — the classify spinner's own `if
		// (staleBranches.length > 0)` guard is never evaluated on this path. Kept as
		// coverage of that early-return behavior; R4b below is what actually exercises
		// the classify spinner's own guard.
		const { fs, git } = classifyScenario({ goneBranches: [], mergedBranches: [] });
		const { ui, calls } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		const starts = calls.filter((c) => c.startsWith(`spinner:start:${CLASSIFY_LABEL_PREFIX}`));
		expect(starts).toHaveLength(0);
	});

	test("R4b: rebase-merged branch with zero gone branches → reaches the classification block with an empty staleBranches, spinner still never starts", async () => {
		// "feature" is proven fully merged during the REBASE phase (all commits
		// cherry-picked into main — revListCherryPickMap returns none unmatched), so
		// update-worktrees reports it "skipped: fully merged" and it lands in
		// `rebaseMerged`, not in `staleBranches` (goneBranches is empty). That makes
		// `rebaseMerged.length > 0` while `staleBranches.length === 0`, which is the
		// ONLY combination that passes the line-338 early-return guard while still
		// leaving `staleBranches` empty — the one path that actually exercises the
		// classify spinner's own `if (staleBranches.length > 0)` guard rather than
		// bypassing it. Mirrors the "fully cherry-picked branch — skipped without
		// rebase" scenario in update-worktrees.test.ts.
		const fs = createFakeFilesystem({
			files: { [`${ROOT}/${CONFIG_FILENAME}`]: CONFIG_OPTOUT },
			directories: [ROOT, `${ROOT}/.worktrees`, featureWt.path],
		});
		const git = createFakeGit({
			root: ROOT,
			mainRoot: ROOT,
			worktrees: [mainWt, featureWt],
			branches: ["main", "feature"],
			goneBranches: [],
			mergedBranches: ["feature"],
			mergeBaseMap: new Map([
				["feature:main", "M0"],
				["main:feature", "M0"],
			]),
			commitCountMap: new Map([["M0..feature", 2]]),
			revListMap: new Map([["main..feature", ["f2", "f1"]]]),
			revListCherryPickMap: new Map([["main...feature", []]]),
		});
		const { ui, calls } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runUpdate(container, { "dry-run": false });

		expect(code).toBe(0);
		const starts = calls.filter((c) => c.startsWith(`spinner:start:${CLASSIFY_LABEL_PREFIX}`));
		expect(starts).toHaveLength(0);
	});
});
