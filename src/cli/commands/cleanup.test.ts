import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONFIG_FILENAME } from "../../domain/constants.ts";
import type { Worktree } from "../../domain/entities/worktree.ts";
import type { UiPort } from "../../domain/ports/ui-port.ts";
import type { Container } from "../../infrastructure/container.ts";
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
			return { update() {}, complete() {}, fail() {}, stop() {} };
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
