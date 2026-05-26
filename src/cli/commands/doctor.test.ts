import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONFIG_FILENAME } from "../../domain/constants.ts";
import type { HealthIssue } from "../../domain/entities/health-check.ts";
import type { Worktree } from "../../domain/entities/worktree.ts";
import type { UiPort } from "../../domain/ports/ui-port.ts";
import type { Container } from "../../infrastructure/container.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit, type FakeGitOptions } from "../../test-utils/fake-git.ts";
import { describeIssue, doctorCommand } from "./doctor.ts";

const ROOT = "/fake/project";

describe("describeIssue", () => {
	test("renders path-drift with branch, actual and expected paths", () => {
		const issue: HealthIssue = {
			type: "path-drift",
			severity: "warning",
			worktreePath: `${ROOT}/.worktrees/old-name`,
			branch: "feature",
			expectedPath: `${ROOT}/.worktrees/feature`,
		};

		const line = describeIssue(issue, ROOT);

		expect(line).toContain("worktree path drift");
		expect(line).toContain("feature");
		expect(line).toContain(".worktrees/old-name");
		expect(line).toContain("expected");
		expect(line).toContain(".worktrees/feature");
	});
});

const CANCEL_SYMBOL = Symbol("cancel");

interface FakeUiLog {
	success: string[];
	error: string[];
	warn: string[];
	outro: string[];
}

function createFakeUi(opts: { nonInteractive?: boolean; confirm?: boolean | symbol } = {}): {
	ui: UiPort;
	log: FakeUiLog;
} {
	const log: FakeUiLog = { success: [], error: [], warn: [], outro: [] };
	const ui = {
		nonInteractive: opts.nonInteractive ?? false,
		intro() {},
		outro(message: string) {
			log.outro.push(message);
		},
		info() {},
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
		isCancel(value: unknown): value is symbol {
			return value === CANCEL_SYMBOL;
		},
		cancel() {},
	} satisfies UiPort;
	return { ui, log };
}

const driftedWt: Worktree = {
	path: `${ROOT}/.worktrees/old-name`,
	branch: "feature",
	head: "ccc",
	isMain: false,
	isPrunable: false,
};
const mainWt: Worktree = { path: ROOT, branch: "main", head: "aaa", isMain: true, isPrunable: false };
const EXPECTED_PATH = `${ROOT}/.worktrees/feature`;

function driftScenario(gitOverrides: Partial<FakeGitOptions> = {}) {
	const fs = createFakeFilesystem({
		files: { [`${ROOT}/${CONFIG_FILENAME}`]: JSON.stringify({ rootDir: ".worktrees" }) },
		directories: [ROOT, `${ROOT}/.worktrees`, driftedWt.path],
	});
	const git = createFakeGit({
		root: ROOT,
		mainRoot: ROOT,
		worktrees: [mainWt, driftedWt],
		...gitOverrides,
	});
	return { fs, git };
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
// Records the FIRST process.exit code. Real process.exit halts the process, but
// our stub throws to unwind. `runCommand` catches any thrown error and may call
// process.exit(EXIT_FAILURE) again — that re-entry is an artifact of the stub,
// so we keep only the first (true) exit code.
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

async function runDoctor(container: Container, args: Record<string, unknown>): Promise<number> {
	const cmd = doctorCommand(container);
	const run = cmd.run as (ctx: { args: Record<string, unknown>; cmd: unknown; rawArgs: string[] }) => Promise<void>;
	try {
		await run({ args, cmd, rawArgs: [] });
		return recordedExit ?? 0;
	} catch (err) {
		if (err instanceof ExitSignal) return recordedExit ?? err.code;
		throw err;
	}
}

describe("doctor --rename", () => {
	test("renames drifted worktrees and reports success", async () => {
		const moveCalls: { from: string; to: string }[] = [];
		const { fs, git } = driftScenario({ moveCalls });
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runDoctor(container, {
			json: false,
			verbose: false,
			fix: false,
			rename: true,
		});

		expect(moveCalls).toEqual([{ from: driftedWt.path, to: EXPECTED_PATH }]);
		expect(log.success.some((m) => m.includes("Renamed"))).toBe(true);
		expect(log.outro.some((m) => m.includes("Renamed 1 drifted worktree"))).toBe(true);
		expect(code).toBe(0);
	});

	test("reports error for a locked worktree without failing the run", async () => {
		const { fs, git } = driftScenario({
			moveFailPaths: new Map([[driftedWt.path, { code: "WORKTREE_LOCKED", message: "needs review" }]]),
		});
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const code = await runDoctor(container, {
			json: false,
			verbose: false,
			fix: false,
			rename: true,
		});

		expect(log.error.some((m) => m.includes("Failed to rename") && m.includes("needs review"))).toBe(true);
		expect(log.outro.some((m) => m.includes("No worktrees renamed"))).toBe(true);
		// Drift remains => partial exit, but the run did not throw.
		expect(code).toBe(2);
	});

	test("non-interactive without --rename warns and does not move", async () => {
		const moveCalls: { from: string; to: string }[] = [];
		const { fs, git } = driftScenario({ moveCalls });
		const { ui, log } = createFakeUi({ nonInteractive: true });
		const container = buildContainer(ui, git, fs);

		const code = await runDoctor(container, {
			json: false,
			verbose: false,
			fix: false,
			rename: false,
		});

		expect(moveCalls).toEqual([]);
		expect(log.warn.some((m) => m.includes("wt doctor --rename"))).toBe(true);
		expect(code).toBe(2);
	});
});
