import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONFIG_FILENAME, LOCAL_CONFIG_FILENAME } from "../../domain/constants.ts";
import type { Worktree } from "../../domain/entities/worktree.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { ShellPort } from "../../domain/ports/shell-port.ts";
import type { UiPort } from "../../domain/ports/ui-port.ts";
import type { Container } from "../../infrastructure/container.ts";
import { Result } from "../../shared/result.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { createFakeShell, type FakeShell } from "../../test-utils/fake-shell.ts";
import { EXIT_CANCEL, EXIT_FAILURE } from "../exit-codes.ts";
import { createCommand } from "./create.ts";

const ROOT = "/fake/project";
const WORKTREES_DIR = ".worktrees";
const FEATURE_PATH = `${ROOT}/${WORKTREES_DIR}/feature`;
const CONFIG_PATH = `${ROOT}/${CONFIG_FILENAME}`;

const CONFIG = JSON.stringify({
	rootDir: WORKTREES_DIR,
	copy: [".env"],
	symlinks: ["node_modules"],
	hooks: { "post-create": ["pnpm install"] },
});

interface FakeUiLog {
	info: string[];
	success: string[];
	warn: string[];
	error: string[];
	outro: string[];
}

interface FakeSpinnerLog {
	start: string[];
	message: string[];
	stop: string[];
}

interface FakeUiOptions {
	nonInteractive?: boolean;
	/** Response for ui.select (value to return). */
	select?: string;
	/** Response for ui.text (value to return). */
	text?: string;
}

function createFakeUi(opts: FakeUiOptions = {}): {
	ui: UiPort;
	log: FakeUiLog;
	spinnerLog: FakeSpinnerLog;
	selectCalls: { message: string; values: string[] }[];
} {
	const log: FakeUiLog = { info: [], success: [], warn: [], error: [], outro: [] };
	const spinnerLog: FakeSpinnerLog = { start: [], message: [], stop: [] };
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
			return {
				start(message: string) {
					spinnerLog.start.push(message);
				},
				message(message: string) {
					spinnerLog.message.push(message);
				},
				stop(message?: string) {
					if (message !== undefined) spinnerLog.stop.push(message);
				},
			};
		},
		createMultiSpinner() {
			return { update() {}, complete() {}, fail() {}, stop() {} };
		},
		async text() {
			return opts.text ?? "";
		},
		async confirm() {
			return true;
		},
		async select<T>(options: { message: string; options: Array<{ value: T; label: string }> }) {
			selectCalls.push({ message: options.message, values: options.options.map((o) => String(o.value)) });
			return (opts.select ?? options.options[0]?.value) as T;
		},
		async multiselect() {
			return [] as never;
		},
		isCancel(_value: unknown): _value is symbol {
			return false;
		},
		cancel() {},
	} satisfies UiPort;

	return { ui, log, spinnerLog, selectCalls };
}

function buildContainer(ui: UiPort, git: GitPort, fs: FilesystemPort, shell: ShellPort): Container {
	return {
		ui,
		git,
		fs,
		shell,
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

async function runCreate(container: Container, args: Record<string, unknown>): Promise<number> {
	const cmd = createCommand(container);
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

interface ScenarioOptions {
	/** Repo config content; `null` omits the config file entirely. */
	config?: string | null;
	files?: Record<string, string>;
	directories?: string[];
	worktrees?: Worktree[];
	branches?: string[];
	remoteBranches?: string[];
}

function scenario(opts: ScenarioOptions = {}): { fs: FilesystemPort; git: GitPort; shell: FakeShell } {
	const files: Record<string, string> = {
		[`${ROOT}/.env`]: "SECRET=1",
		...(opts.config === null ? {} : { [CONFIG_PATH]: opts.config ?? CONFIG }),
		...opts.files,
	};
	const fs = createFakeFilesystem({
		files,
		directories: [ROOT, `${ROOT}/${WORKTREES_DIR}`, `${ROOT}/node_modules`, ...(opts.directories ?? [])],
	});
	const git = createFakeGit({
		root: ROOT,
		mainRoot: ROOT,
		worktrees: opts.worktrees ?? [mainWt],
		branches: opts.branches ?? ["main"],
		remoteBranches: opts.remoteBranches ?? [],
	});
	return { fs, git, shell: createFakeShell() };
}

/** Wraps a fake git so the worktree-creation calls can be inspected. */
function spyCreateCalls(git: GitPort): {
	git: GitPort;
	createCalls: { branch: string; path: string; baseBranch: string | undefined }[];
	fromRemoteCalls: { branch: string; path: string }[];
} {
	const createCalls: { branch: string; path: string; baseBranch: string | undefined }[] = [];
	const fromRemoteCalls: { branch: string; path: string }[] = [];
	return {
		git: {
			...git,
			async createWorktree(branch, path, baseBranch) {
				createCalls.push({ branch, path, baseBranch });
				return git.createWorktree(branch, path, baseBranch);
			},
			async createWorktreeFromRemote(branch, path, remote) {
				fromRemoteCalls.push({ branch, path });
				return git.createWorktreeFromRemote(branch, path, remote);
			},
		},
		createCalls,
		fromRemoteCalls,
	};
}

function args(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { branch: "feature", base: "main", "dry-run": false, ...overrides };
}

async function listPaths(git: GitPort): Promise<string[]> {
	const result = await git.listWorktrees();
	return result.success ? result.data.map((w) => w.path) : [];
}

describe("create — happy path", () => {
	test("creates the worktree, links config, copies files, symlinks and runs hooks", async () => {
		const { fs, git: baseGit, shell } = scenario();
		const { git, createCalls } = spyCreateCalls(baseGit);
		const { ui, log, spinnerLog } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runCreate(container, args());

		expect(code).toBe(0);
		expect(createCalls).toEqual([{ branch: "feature", path: FEATURE_PATH, baseBranch: "main" }]);
		expect(await listPaths(git)).toContain(FEATURE_PATH);

		// Config symlink + declared symlink + copied file all landed in the worktree.
		expect(await fs.isSymlink(`${FEATURE_PATH}/${CONFIG_FILENAME}`)).toBe(true);
		expect(await fs.isSymlink(`${FEATURE_PATH}/node_modules`)).toBe(true);
		const copied = await fs.readFile(`${FEATURE_PATH}/.env`);
		expect(copied.success && copied.data).toBe("SECRET=1");

		// post-create hook ran inside the worktree with the documented env.
		expect(shell.calls).toHaveLength(1);
		expect(shell.calls[0]?.command).toBe("pnpm install");
		expect(shell.calls[0]?.options.cwd).toBe(FEATURE_PATH);
		expect(shell.calls[0]?.options.env).toEqual({
			WORKTREE_PATH: FEATURE_PATH,
			WORKTREE_BRANCH: "feature",
			REPO_ROOT: ROOT,
			BASE_BRANCH: "main",
		});

		expect(spinnerLog.stop.some((m) => m.includes("Worktree created"))).toBe(true);
		expect(spinnerLog.stop.some((m) => m.includes("Hooks completed"))).toBe(true);
		expect(log.success.some((m) => m.includes(`Created worktree for branch: feature at ${FEATURE_PATH}`))).toBe(true);
		expect(log.outro).toEqual(["Done!"]);
		expect(log.error).toEqual([]);
	});

	test("no post-create hooks → shell is never touched, still reports success", async () => {
		const { fs, git, shell } = scenario({ config: JSON.stringify({ rootDir: WORKTREES_DIR }) });
		const { ui, log, spinnerLog } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runCreate(container, args());

		expect(code).toBe(0);
		expect(shell.calls).toEqual([]);
		expect(spinnerLog.stop.some((m) => m.includes("Hooks completed"))).toBe(false);
		expect(log.outro).toEqual(["Done!"]);
	});

	test("no base flag → prompts for the source branch and passes the pick to git", async () => {
		const { fs, git: baseGit, shell } = scenario({ branches: ["main", "develop"] });
		const { git, createCalls } = spyCreateCalls(baseGit);
		const { ui, selectCalls } = createFakeUi({ select: "develop" });
		const container = buildContainer(ui, git, fs, shell);

		const code = await runCreate(container, args({ base: undefined }));

		expect(code).toBe(0);
		expect(selectCalls.map((c) => c.message)).toContain("Select source branch");
		expect(createCalls[0]?.baseBranch).toBe("develop");
	});

	test("existing local branch → no base resolution, worktree checked out as-is", async () => {
		const { fs, git: baseGit, shell } = scenario({ branches: ["main", "feature"] });
		const { git, createCalls, fromRemoteCalls } = spyCreateCalls(baseGit);
		const { ui, selectCalls } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runCreate(container, args({ base: undefined }));

		expect(code).toBe(0);
		expect(selectCalls).toEqual([]);
		expect(createCalls).toEqual([{ branch: "feature", path: FEATURE_PATH, baseBranch: undefined }]);
		expect(fromRemoteCalls).toEqual([]);
	});

	test("remote-only branch → checked out from the remote, no base resolution", async () => {
		const { fs, git: baseGit, shell } = scenario({ remoteBranches: ["feature"] });
		const { git, createCalls, fromRemoteCalls } = spyCreateCalls(baseGit);
		const { ui, selectCalls } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runCreate(container, args({ base: undefined }));

		expect(code).toBe(0);
		expect(selectCalls).toEqual([]);
		expect(fromRemoteCalls).toEqual([{ branch: "feature", path: FEATURE_PATH }]);
		expect(createCalls).toEqual([]);
	});

	test("local config present → both config symlinks are created", async () => {
		const { fs, git, shell } = scenario({
			files: { [`${ROOT}/${LOCAL_CONFIG_FILENAME}`]: JSON.stringify({ rootDir: WORKTREES_DIR }) },
		});
		const { ui } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runCreate(container, args());

		expect(code).toBe(0);
		expect(await fs.isSymlink(`${FEATURE_PATH}/${CONFIG_FILENAME}`)).toBe(true);
		expect(await fs.isSymlink(`${FEATURE_PATH}/${LOCAL_CONFIG_FILENAME}`)).toBe(true);
	});
});

describe("create --dry-run", () => {
	test("previews the plan and touches nothing", async () => {
		const { fs, git: baseGit, shell } = scenario();
		const { git, createCalls, fromRemoteCalls } = spyCreateCalls(baseGit);
		const { ui, log, spinnerLog } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runCreate(container, args({ "dry-run": true }));

		expect(code).toBe(0);
		expect(createCalls).toEqual([]);
		expect(fromRemoteCalls).toEqual([]);
		expect(await listPaths(git)).toEqual([ROOT]);
		expect(await fs.exists(`${FEATURE_PATH}/.env`)).toBe(false);
		expect(shell.calls).toEqual([]);

		expect(log.info).toContain(`Would create worktree at ${FEATURE_PATH}`);
		expect(log.info).toContain("Branch: feature (new, from main)");
		expect(log.info.some((m) => m.startsWith("Would symlink config:"))).toBe(true);
		expect(log.info).toContain("Would copy 1 file(s):");
		expect(log.info).toContain("  file: .env");
		expect(log.info).toContain("Would create 1 symlink(s):");
		expect(log.info).toContain("  link: node_modules");
		expect(log.info).toContain("Would run 1 hook(s):");
		expect(log.info).toContain("  pnpm install");
		expect(spinnerLog.stop).toContain("Preview");
		expect(log.outro).toEqual(["Dry run — no changes made"]);
	});

	test("existing branch is previewed as existing, without a base", async () => {
		const { fs, git, shell } = scenario({ branches: ["main", "feature"] });
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runCreate(container, args({ base: undefined, "dry-run": true }));

		expect(code).toBe(0);
		expect(log.info).toContain("Branch: feature (existing)");
	});
});

describe("create — failure modes", () => {
	test("branch already has a worktree → exits with failure and no rollback noise", async () => {
		const featureWt: Worktree = {
			path: FEATURE_PATH,
			branch: "feature",
			head: "bbb",
			isMain: false,
			isPrunable: false,
		};
		const { fs, git, shell } = scenario({ worktrees: [mainWt, featureWt], branches: ["main", "feature"] });
		const { ui, log, spinnerLog } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runCreate(container, args({ base: undefined }));

		expect(code).toBe(EXIT_FAILURE);
		expect(spinnerLog.stop.some((m) => m.includes("Failed"))).toBe(true);
		expect(log.error.some((m) => m.includes("already exists at"))).toBe(true);
		expect(log.outro).toEqual([]);
	});

	test("target directory exists but is not a worktree → exits with failure", async () => {
		const { fs, git, shell } = scenario({ directories: [FEATURE_PATH] });
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runCreate(container, args());

		expect(code).toBe(EXIT_FAILURE);
		expect(log.error.some((m) => m.includes("already exists but is not a worktree"))).toBe(true);
	});

	test("git refuses to create the worktree → error surfaced, nothing copied", async () => {
		const { fs, git: baseGit, shell } = scenario();
		const git: GitPort = {
			...baseGit,
			async createWorktree() {
				return Result.err({ code: "UNKNOWN", message: "fatal: could not create work tree" });
			},
		};
		const { ui, log, spinnerLog } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runCreate(container, args());

		expect(code).toBe(EXIT_FAILURE);
		expect(spinnerLog.stop.some((m) => m.includes("Failed"))).toBe(true);
		expect(log.error.some((m) => m.includes("fatal: could not create work tree"))).toBe(true);
		expect(await fs.exists(`${FEATURE_PATH}/.env`)).toBe(false);
		expect(shell.calls).toEqual([]);
	});

	test("non-interactive without a branch name → usage error", async () => {
		const { fs, git, shell } = scenario();
		const { ui, log } = createFakeUi({ nonInteractive: true });
		const container = buildContainer(ui, git, fs, shell);

		const code = await runCreate(container, args({ branch: undefined, base: undefined }));

		expect(code).not.toBe(0);
		expect(log.error.some((m) => m.includes("Branch name is required in non-interactive mode"))).toBe(true);
	});
});

describe("create — degraded steps stay non-fatal", () => {
	test("config symlink failure only warns", async () => {
		const { fs: baseFs, git, shell } = scenario();
		const fs: FilesystemPort = {
			...baseFs,
			async createSymlink(target, linkPath) {
				if (linkPath.endsWith(CONFIG_FILENAME)) {
					return Result.err({ code: "UNKNOWN", message: "permission denied", path: linkPath });
				}
				return baseFs.createSymlink(target, linkPath);
			},
		};
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runCreate(container, args());

		expect(code).toBe(0);
		expect(log.warn.some((m) => m.includes("Failed to symlink config: permission denied"))).toBe(true);
		expect(log.outro).toEqual(["Done!"]);
	});

	test("copy failure only warns", async () => {
		const { fs: baseFs, git, shell } = scenario();
		const fs: FilesystemPort = {
			...baseFs,
			async copyFile(source) {
				return Result.err({ code: "UNKNOWN", message: "disk full", path: source });
			},
		};
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runCreate(container, args());

		expect(code).toBe(0);
		expect(log.warn.some((m) => m.includes("Failed to copy .env: disk full"))).toBe(true);
		expect(log.outro).toEqual(["Done!"]);
	});

	test("symlink failure only warns", async () => {
		const { fs: baseFs, git, shell } = scenario();
		const fs: FilesystemPort = {
			...baseFs,
			async createSymlink(target, linkPath) {
				if (linkPath.endsWith("node_modules")) {
					return Result.err({ code: "UNKNOWN", message: "loop detected", path: linkPath });
				}
				return baseFs.createSymlink(target, linkPath);
			},
		};
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runCreate(container, args());

		expect(code).toBe(0);
		expect(log.warn.some((m) => m.includes("Failed to create symlink") && m.includes("loop detected"))).toBe(true);
		expect(log.outro).toEqual(["Done!"]);
	});

	test("failing hook only warns and the command still completes", async () => {
		const { fs, git } = scenario();
		const shell = createFakeShell({
			results: new Map([["pnpm install", Result.err({ code: "EXECUTION_FAILED", message: "exit 1" })]]),
		});
		const { ui, log, spinnerLog } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runCreate(container, args());

		expect(code).toBe(0);
		expect(log.warn.some((m) => m.includes('Hook failed: "pnpm install" - exit 1'))).toBe(true);
		expect(spinnerLog.stop.some((m) => m.includes("Hooks completed"))).toBe(true);
		expect(log.outro).toEqual(["Done!"]);
	});

	test("missing config → warns and falls back to defaults", async () => {
		const { fs, git, shell } = scenario({ config: null });
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runCreate(container, args());

		expect(code).toBe(0);
		expect(log.warn.some((m) => m.includes("Config not found at"))).toBe(true);
		expect(log.warn.some((m) => m.includes("Config not found, using defaults"))).toBe(true);
		expect(log.outro).toEqual(["Done!"]);
	});
});

describe("create — SIGINT rollback", () => {
	// The command registers a CleanupHandle right after the worktree exists, so an
	// interrupt mid-setup force-removes the half-built worktree. The rollback's
	// Result is deliberately ignored: a failing rollback must not mask the cancel.
	async function flush(): Promise<void> {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}

	test("interrupt while copying → worktree is force-removed and the process cancels", async () => {
		const { fs: baseFs, git: baseGit, shell } = scenario();
		const removeCalls: { path: string; force: boolean | undefined }[] = [];
		const git: GitPort = {
			...baseGit,
			async removeWorktree(path, options) {
				removeCalls.push({ path, force: options?.force });
				// Rollback itself fails — create.ts must swallow it.
				return Result.err({ code: "UNKNOWN", message: "rollback failed" });
			},
		};

		let releaseCopy: () => void = () => {};
		let signalCopyStarted: () => void = () => {};
		const copyStarted = new Promise<void>((resolve) => {
			signalCopyStarted = resolve;
		});
		const copyGate = new Promise<void>((resolve) => {
			releaseCopy = resolve;
		});
		const fs: FilesystemPort = {
			...baseFs,
			async copyFile(source, destination) {
				signalCopyStarted();
				await copyGate;
				return baseFs.copyFile(source, destination);
			},
		};

		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		// The SIGINT handler exits from inside a `.finally()`; a throwing process.exit
		// stub would surface there as an unhandled rejection, so record instead.
		const exitCodes: number[] = [];
		process.exit = ((code?: number) => {
			exitCodes.push(code ?? 0);
		}) as unknown as typeof process.exit;

		const before = process.listeners("SIGINT");
		const run = runCreate(container, args());
		await copyStarted;

		const added = process.listeners("SIGINT").filter((listener) => !before.includes(listener));
		expect(added).toHaveLength(1);
		(added[0] as () => void)();
		await flush();

		expect(removeCalls).toEqual([{ path: FEATURE_PATH, force: true }]);
		expect(exitCodes).toContain(EXIT_CANCEL);

		releaseCopy();
		await run;

		// The failed rollback is swallowed: nothing about it reaches the user.
		expect(log.error).toEqual([]);
		expect(log.warn.some((m) => m.includes("rollback failed"))).toBe(false);
	});

	test("successful run clears the interrupt handler", async () => {
		const { fs, git, shell } = scenario();
		const { ui } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const before = process.listenerCount("SIGINT");
		const code = await runCreate(container, args());

		expect(code).toBe(0);
		expect(process.listenerCount("SIGINT")).toBe(before);
	});
});
