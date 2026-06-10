import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONFIG_FILENAME } from "../../domain/constants.ts";
import type { Worktree } from "../../domain/entities/worktree.ts";
import type { UiPort } from "../../domain/ports/ui-port.ts";
import type { Container } from "../../infrastructure/container.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit, type FakeGitOptions } from "../../test-utils/fake-git.ts";
import { removeCommand } from "./remove.ts";

const ROOT = "/fake/project";

interface FakeUiLog {
	info: string[];
	success: string[];
	warn: string[];
	error: string[];
	outro: string[];
}

interface MultiSpinnerCall {
	key: string;
	message: string;
}

interface FakeMultiSpinnerLog {
	complete: MultiSpinnerCall[];
	fail: MultiSpinnerCall[];
}

function createFakeUi(opts: { nonInteractive?: boolean; confirm?: boolean; multiselectResult?: string[] } = {}): {
	ui: UiPort;
	log: FakeUiLog;
	multiSpinnerLog: FakeMultiSpinnerLog;
} {
	const log: FakeUiLog = { info: [], success: [], warn: [], error: [], outro: [] };
	const multiSpinnerLog: FakeMultiSpinnerLog = { complete: [], fail: [] };

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
		createMultiSpinner(_keys: string[]) {
			return {
				update() {},
				complete(key: string, message: string) {
					multiSpinnerLog.complete.push({ key, message });
				},
				fail(key: string, message: string) {
					multiSpinnerLog.fail.push({ key, message });
				},
				stop() {},
			};
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
			return (opts.multiselectResult ?? []) as never;
		},
		isCancel(_value: unknown): _value is symbol {
			return false;
		},
		cancel() {},
	} satisfies UiPort;

	return { ui, log, multiSpinnerLog };
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

async function runRemove(container: Container, args: Record<string, unknown>): Promise<number> {
	const cmd = removeCommand(container);
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
const feature2Wt: Worktree = {
	path: `${ROOT}/.worktrees/feature2`,
	branch: "feature2",
	head: "ccc",
	isMain: false,
	isPrunable: false,
};

function multiRemoveScenario(gitOverrides: Partial<FakeGitOptions> = {}) {
	const fs = createFakeFilesystem({
		files: { [`${ROOT}/${CONFIG_FILENAME}`]: JSON.stringify({ rootDir: ".worktrees" }) },
		directories: [ROOT, `${ROOT}/.worktrees`, featureWt.path, feature2Wt.path],
	});
	const git = createFakeGit({
		root: ROOT,
		mainRoot: ROOT,
		worktrees: [mainWt, featureWt, feature2Wt],
		branches: ["main", "feature", "feature2"],
		mergedBranches: ["feature", "feature2"],
		...gitOverrides,
	});
	return { fs, git };
}

const removeArgs = {
	branch: undefined,
	"delete-branch": true,
	"delete-remote-branch": true,
	yes: true,
	force: false,
	"dry-run": false,
};

describe("remove — multi path branch delete failures", () => {
	test("deleteBranch fails with non-BRANCH_NOT_MERGED error → complete message contains 'branch delete failed' and warn log mentions branch", async () => {
		// feature2 branch is absent from the branches array → deleteBranch returns BRANCH_NOT_FOUND
		const { fs, git } = multiRemoveScenario({
			branches: ["main", "feature"],
			mergedBranches: ["feature"],
			worktrees: [mainWt, featureWt, feature2Wt],
		});
		const { ui, log, multiSpinnerLog } = createFakeUi({
			multiselectResult: [featureWt.path, feature2Wt.path],
		});
		const container = buildContainer(ui, git, fs);

		const code = await runRemove(container, removeArgs);

		const feature2Complete = multiSpinnerLog.complete.find((c) => c.key === feature2Wt.path);
		expect(feature2Complete).toBeDefined();
		expect(feature2Complete?.message).toContain("branch delete failed");

		const branchWarn = log.warn.find((m) => m.includes("feature2") && m.includes("Branch"));
		expect(branchWarn).toBeDefined();
		expect(branchWarn).toContain("feature2");

		expect(code).toBe(0);
	});

	test("remote delete fails with non-REMOTE_REF_NOT_FOUND error → warn log contains remote error message, complete contains 'branch deleted (local)'", async () => {
		const { fs, git } = multiRemoveScenario({
			deleteRemoteBranchFail: { code: "UNKNOWN", message: "remote rejected" },
		});
		const { ui, log, multiSpinnerLog } = createFakeUi({
			multiselectResult: [featureWt.path, feature2Wt.path],
		});
		const container = buildContainer(ui, git, fs);

		const code = await runRemove(container, removeArgs);

		const remoteWarn = log.warn.find((m) => m.includes("remote") && m.includes("remote rejected"));
		expect(remoteWarn).toBeDefined();

		const featureComplete = multiSpinnerLog.complete.find((c) => c.key === featureWt.path);
		expect(featureComplete).toBeDefined();
		expect(featureComplete?.message).toContain("branch deleted (local)");
		expect(featureComplete?.message).not.toContain("& remote");

		expect(code).toBe(0);
	});

	test("remote delete fails with REMOTE_REF_NOT_FOUND → no warning emitted, complete still contains 'branch deleted (local)'", async () => {
		const { fs, git } = multiRemoveScenario({
			deleteRemoteBranchFail: { code: "REMOTE_REF_NOT_FOUND", message: "no remote ref" },
		});
		const { ui, log, multiSpinnerLog } = createFakeUi({
			multiselectResult: [featureWt.path, feature2Wt.path],
		});
		const container = buildContainer(ui, git, fs);

		const code = await runRemove(container, removeArgs);

		const remoteWarn = log.warn.find((m) => m.includes("remote branch") || m.includes("no remote ref"));
		expect(remoteWarn).toBeUndefined();

		const featureComplete = multiSpinnerLog.complete.find((c) => c.key === featureWt.path);
		expect(featureComplete).toBeDefined();
		expect(featureComplete?.message).toContain("branch deleted (local)");
		expect(featureComplete?.message).not.toContain("& remote");

		expect(code).toBe(0);
	});
});
