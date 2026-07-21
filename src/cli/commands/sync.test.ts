import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONFIG_FILENAME, LEGACY_CONFIG_FILENAME } from "../../domain/constants.ts";
import type { Worktree } from "../../domain/entities/worktree.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { ShellPort } from "../../domain/ports/shell-port.ts";
import type { UiPort } from "../../domain/ports/ui-port.ts";
import type { Container } from "../../infrastructure/container.ts";
import { Result } from "../../shared/result.ts";
import { createFakeFilesystem, type FakeFilesystemOptions } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { createFakeShell, type FakeShell } from "../../test-utils/fake-shell.ts";
import { EXIT_FAILURE } from "../exit-codes.ts";
import { syncCommand } from "./sync.ts";

const ROOT = "/fake/project";
const WORKTREES_DIR = ".worktrees";
const FEATURE_PATH = `${ROOT}/${WORKTREES_DIR}/feature`;
const FEATURE2_PATH = `${ROOT}/${WORKTREES_DIR}/feature2`;
const CONFIG_PATH = `${ROOT}/${CONFIG_FILENAME}`;

const CONFIG = JSON.stringify({
	rootDir: WORKTREES_DIR,
	copy: [".env"],
	symlinks: ["node_modules"],
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
	stop: string[];
}

function createFakeUi(): { ui: UiPort; log: FakeUiLog; spinnerLog: FakeSpinnerLog } {
	const log: FakeUiLog = { info: [], success: [], warn: [], error: [], outro: [] };
	const spinnerLog: FakeSpinnerLog = { start: [], stop: [] };

	const ui = {
		nonInteractive: false,
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
				message() {},
				stop(message?: string) {
					if (message !== undefined) spinnerLog.stop.push(message);
				},
			};
		},
		createMultiSpinner() {
			return { update() {}, complete() {}, fail() {}, stop() {} };
		},
		async text() {
			return "";
		},
		async confirm() {
			return true;
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

	return { ui, log, spinnerLog };
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

async function runSync(container: Container, args: Record<string, unknown>): Promise<number> {
	const cmd = syncCommand(container);
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
const featureWt: Worktree = { path: FEATURE_PATH, branch: "feature", head: "bbb", isMain: false, isPrunable: false };
const feature2Wt: Worktree = { path: FEATURE2_PATH, branch: "feature2", head: "ccc", isMain: false, isPrunable: false };

interface ScenarioOptions {
	/** Repo config content; `null` omits the config file entirely. */
	config?: string | null;
	configFilename?: string;
	files?: Record<string, string>;
	directories?: string[];
	symlinks?: FakeFilesystemOptions["symlinks"];
	brokenSymlinks?: string[];
	worktrees?: Worktree[];
	isRepo?: boolean;
	shell?: FakeShell;
}

function scenario(opts: ScenarioOptions = {}): { fs: FilesystemPort; git: GitPort; shell: FakeShell } {
	const configFile = `${ROOT}/${opts.configFilename ?? CONFIG_FILENAME}`;
	const files: Record<string, string> = {
		[`${ROOT}/.env`]: "SECRET=1",
		...(opts.config === null ? {} : { [configFile]: opts.config ?? CONFIG }),
		...opts.files,
	};
	const fs = createFakeFilesystem({
		files,
		directories: [
			ROOT,
			`${ROOT}/${WORKTREES_DIR}`,
			`${ROOT}/node_modules`,
			FEATURE_PATH,
			FEATURE2_PATH,
			...(opts.directories ?? []),
		],
		symlinks: opts.symlinks ?? {},
		brokenSymlinks: opts.brokenSymlinks ?? [],
	});
	const git = createFakeGit({
		isRepo: opts.isRepo ?? true,
		root: ROOT,
		mainRoot: ROOT,
		worktrees: opts.worktrees ?? [mainWt, featureWt],
		branches: ["main", "feature", "feature2"],
	});
	return { fs, git, shell: opts.shell ?? createFakeShell() };
}

function args(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { branch: undefined, "dry-run": false, force: false, ...overrides };
}

describe("sync — happy path", () => {
	test("applies config symlink, declared symlinks and copies to every worktree", async () => {
		const { fs, git, shell } = scenario({ worktrees: [mainWt, featureWt, feature2Wt] });
		const { ui, log, spinnerLog } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runSync(container, args());

		expect(code).toBe(0);
		for (const path of [FEATURE_PATH, FEATURE2_PATH]) {
			expect(await fs.isSymlink(`${path}/${CONFIG_FILENAME}`)).toBe(true);
			expect(await fs.isSymlink(`${path}/node_modules`)).toBe(true);
			const copied = await fs.readFile(`${path}/.env`);
			expect(copied.success && copied.data).toBe("SECRET=1");
		}

		expect(log.success).toHaveLength(2);
		expect(log.success.some((m) => m.includes("feature") && m.includes(`${WORKTREES_DIR}/feature`))).toBe(true);
		expect(log.success.every((m) => m.includes("add 2 symlink(s)") && m.includes("copy 1 file(s)"))).toBe(true);
		expect(spinnerLog.start).toEqual(["Syncing worktrees..."]);
		expect(spinnerLog.stop.some((m) => m.includes("Done"))).toBe(true);
		expect(log.outro).toEqual(["Done!"]);
	});

	test("nothing to change → worktree reported as up to date", async () => {
		const { fs, git, shell } = scenario({
			config: JSON.stringify({ rootDir: WORKTREES_DIR }),
			symlinks: { [`${FEATURE_PATH}/${CONFIG_FILENAME}`]: CONFIG_PATH },
		});
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runSync(container, args());

		expect(code).toBe(0);
		expect(log.success).toEqual([]);
		expect(log.info.some((m) => m.includes("feature") && m.includes("up to date"))).toBe(true);
		expect(log.outro).toEqual(["Done!"]);
	});

	test("broken config symlink is recreated", async () => {
		const { fs, git, shell } = scenario({
			config: JSON.stringify({ rootDir: WORKTREES_DIR }),
			brokenSymlinks: [`${FEATURE_PATH}/${CONFIG_FILENAME}`],
		});
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runSync(container, args());

		expect(code).toBe(0);
		expect(log.success.some((m) => m.includes("recreate 1 broken symlink(s)"))).toBe(true);
		expect(await fs.isSymlinkBroken(`${FEATURE_PATH}/${CONFIG_FILENAME}`)).toBe(false);
	});

	test("branch argument limits the sync to that worktree", async () => {
		const { fs, git, shell } = scenario({ worktrees: [mainWt, featureWt, feature2Wt] });
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runSync(container, args({ branch: "feature" }));

		expect(code).toBe(0);
		expect(log.success).toHaveLength(1);
		expect(log.success[0]).toContain("feature");
		expect(await fs.exists(`${FEATURE_PATH}/.env`)).toBe(true);
		expect(await fs.exists(`${FEATURE2_PATH}/.env`)).toBe(false);
	});

	test("no worktrees besides main → reports nothing to sync", async () => {
		const { fs, git, shell } = scenario({ worktrees: [mainWt] });
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runSync(container, args());

		expect(code).toBe(0);
		expect(log.info).toContain("No worktrees to sync");
		expect(log.outro).toEqual(["Done!"]);
	});
});

describe("sync --dry-run", () => {
	test("reports the plan with 'would' verbs and writes nothing", async () => {
		const { fs, git, shell } = scenario();
		const { ui, log, spinnerLog } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runSync(container, args({ "dry-run": true }));

		expect(code).toBe(0);
		expect(log.success.some((m) => m.includes("would add 2 symlink(s)") && m.includes("would copy 1 file(s)"))).toBe(
			true,
		);
		expect(await fs.exists(`${FEATURE_PATH}/.env`)).toBe(false);
		expect(await fs.isSymlink(`${FEATURE_PATH}/${CONFIG_FILENAME}`)).toBe(false);
		expect(spinnerLog.start).toEqual(["Resolving sync plan..."]);
		expect(spinnerLog.stop.some((m) => m.includes("Plan ready"))).toBe(true);
		expect(log.outro).toEqual(["Dry run — no changes made"]);
	});

	test("post-sync hooks never run in dry-run", async () => {
		const { fs, git, shell } = scenario({
			config: JSON.stringify({ rootDir: WORKTREES_DIR, hooks: { "post-sync": ["pnpm install"] } }),
		});
		const { ui } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runSync(container, args({ "dry-run": true }));

		expect(code).toBe(0);
		expect(shell.calls).toEqual([]);
	});
});

describe("sync — existing destinations", () => {
	test("existing file is skipped with a --force hint", async () => {
		const { fs, git, shell } = scenario({ files: { [`${FEATURE_PATH}/.env`]: "OLD=1" } });
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runSync(container, args());

		expect(code).toBe(0);
		expect(log.warn.some((m) => m.includes("1 file(s) already exist at destination"))).toBe(true);
		expect(log.warn.some((m) => m.includes("--force"))).toBe(true);
		const kept = await fs.readFile(`${FEATURE_PATH}/.env`);
		expect(kept.success && kept.data).toBe("OLD=1");
	});

	test("--force overwrites the destination", async () => {
		const { fs, git, shell } = scenario({ files: { [`${FEATURE_PATH}/.env`]: "OLD=1" } });
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runSync(container, args({ force: true }));

		expect(code).toBe(0);
		expect(log.warn.some((m) => m.includes("already exist at destination"))).toBe(false);
		expect(log.success.some((m) => m.includes("overwrite 1 file(s)"))).toBe(true);
		const overwritten = await fs.readFile(`${FEATURE_PATH}/.env`);
		expect(overwritten.success && overwritten.data).toBe("SECRET=1");
	});

	test("a real file where a symlink belongs is left alone with a warning", async () => {
		const { fs, git, shell } = scenario({
			config: JSON.stringify({ rootDir: WORKTREES_DIR }),
			files: { [`${FEATURE_PATH}/${CONFIG_FILENAME}`]: "{}" },
		});
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runSync(container, args());

		expect(code).toBe(0);
		expect(log.warn.some((m) => m.includes("exists but is not a symlink"))).toBe(true);
		expect(await fs.isSymlink(`${FEATURE_PATH}/${CONFIG_FILENAME}`)).toBe(false);
	});
});

describe("sync — post-sync hooks", () => {
	test("hooks run per worktree with the documented env", async () => {
		const { fs, git, shell } = scenario({
			config: JSON.stringify({ rootDir: WORKTREES_DIR, hooks: { "post-sync": ["pnpm install"] } }),
		});
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runSync(container, args());

		expect(code).toBe(0);
		expect(shell.calls).toHaveLength(1);
		expect(shell.calls[0]?.command).toBe("pnpm install");
		expect(shell.calls[0]?.options.cwd).toBe(FEATURE_PATH);
		expect(shell.calls[0]?.options.env).toEqual({
			WORKTREE_PATH: FEATURE_PATH,
			WORKTREE_BRANCH: "feature",
			REPO_ROOT: ROOT,
		});
		expect(log.outro).toEqual(["Done!"]);
	});

	test("failing hook is reported as a warning, exit stays 0", async () => {
		const shell = createFakeShell({
			results: new Map([["pnpm install", Result.err({ code: "EXECUTION_FAILED", message: "exit 1" })]]),
		});
		const { fs, git } = scenario({
			config: JSON.stringify({ rootDir: WORKTREES_DIR, hooks: { "post-sync": ["pnpm install"] } }),
			shell,
		});
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runSync(container, args());

		expect(code).toBe(0);
		expect(log.warn.some((m) => m.includes('Hook failed: "pnpm install" - exit 1'))).toBe(true);
		expect(log.outro).toEqual(["Done!"]);
	});
});

describe("sync — failure modes", () => {
	test("unknown branch → failure exit with the spinner marked failed", async () => {
		const { fs, git, shell } = scenario();
		const { ui, log, spinnerLog } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runSync(container, args({ branch: "nope" }));

		expect(code).toBe(EXIT_FAILURE);
		expect(spinnerLog.stop.some((m) => m.includes("Failed"))).toBe(true);
		expect(log.error.some((m) => m.includes('Branch "nope" not found in worktrees'))).toBe(true);
		expect(log.outro).toEqual([]);
	});

	test("outside a git repository → failure exit before any config load", async () => {
		const { fs, git, shell } = scenario({ isRepo: false });
		const { ui, log, spinnerLog } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runSync(container, args());

		expect(code).toBe(EXIT_FAILURE);
		expect(log.error.some((m) => m.includes("Not inside a git repository"))).toBe(true);
		expect(spinnerLog.start).toEqual([]);
	});

	test("missing config → warns and syncs with defaults", async () => {
		const { fs, git, shell } = scenario({ config: null });
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runSync(container, args());

		expect(code).toBe(0);
		expect(log.warn.some((m) => m.includes("Config not found at"))).toBe(true);
		expect(log.info.some((m) => m.includes("up to date"))).toBe(true);
		expect(log.outro).toEqual(["Done!"]);
	});

	test("legacy config → migration warning, sync still runs", async () => {
		const { fs, git, shell } = scenario({
			configFilename: LEGACY_CONFIG_FILENAME,
			config: JSON.stringify({ rootDir: WORKTREES_DIR, copy: [".env"] }),
		});
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs, shell);

		const code = await runSync(container, args());

		expect(code).toBe(0);
		expect(log.warn.some((m) => m.includes("Using legacy .worktreekitrc config"))).toBe(true);
		expect(await fs.exists(`${FEATURE_PATH}/.env`)).toBe(true);
	});
});
