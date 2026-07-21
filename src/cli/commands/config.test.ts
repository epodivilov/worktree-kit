import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONFIG_FILENAME, LOCAL_CONFIG_FILENAME } from "../../domain/constants.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { UiPort } from "../../domain/ports/ui-port.ts";
import type { Container } from "../../infrastructure/container.ts";
import { resolveGlobalConfigPath } from "../../shared/xdg-paths.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { EXIT_FAILURE } from "../exit-codes.ts";
import { configCommand } from "./config.ts";

const ROOT = "/fake/project";
const CONFIG_PATH = `${ROOT}/${CONFIG_FILENAME}`;
const LOCAL_CONFIG_PATH = `${ROOT}/${LOCAL_CONFIG_FILENAME}`;
const GLOBAL_CONFIG_PATH = resolveGlobalConfigPath();

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Output is colorized through picocolors; assertions compare on the plain text. */
function plain(value: string | undefined): string {
	return (value ?? "").replace(ANSI_PATTERN, "");
}

interface FakeUiLog {
	info: string[];
	error: string[];
	outro: string[];
}

function createFakeUi(): { ui: UiPort; log: FakeUiLog } {
	const log: FakeUiLog = { info: [], error: [], outro: [] };

	const ui = {
		nonInteractive: false,
		intro() {},
		outro(message: string) {
			log.outro.push(message);
		},
		info(message: string) {
			log.info.push(message);
		},
		success() {},
		warn() {},
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

	return { ui, log };
}

function buildContainer(ui: UiPort, git: GitPort, fs: FilesystemPort): Container {
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

interface CommandLike {
	run: (ctx: { args: Record<string, unknown>; cmd: unknown; rawArgs: string[] }) => Promise<void>;
}

async function resolveShow(container: Container): Promise<CommandLike> {
	const subCommands = configCommand(container).subCommands as Record<string, unknown> | undefined;
	const show = subCommands?.show;
	const resolved = typeof show === "function" ? await (show as () => unknown)() : await show;
	return resolved as CommandLike;
}

interface RunResult {
	code: number;
	stdout: string[];
	stderr: string[];
}

async function runConfigShow(container: Container, args: Record<string, unknown>): Promise<RunResult> {
	const cmd = await resolveShow(container);
	const stdout: string[] = [];
	const stderr: string[] = [];
	const originalStdout = process.stdout.write;
	const originalStderr = process.stderr.write;
	process.stdout.write = ((chunk: unknown): boolean => {
		stdout.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: unknown): boolean => {
		stderr.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;

	try {
		await cmd.run({ args, cmd, rawArgs: [] });
		return { code: recordedExit ?? 0, stdout, stderr };
	} catch (err) {
		if (err instanceof ExitSignal) return { code: recordedExit ?? err.code, stdout, stderr };
		throw err;
	} finally {
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
	}
}

interface ScenarioOptions {
	/** Repo config content; `null` omits the config file entirely. */
	config?: string | null;
	local?: string;
	global?: string;
}

function scenario(opts: ScenarioOptions = {}): { fs: FilesystemPort; git: GitPort } {
	const files: Record<string, string> = {
		...(opts.config === null
			? {}
			: { [CONFIG_PATH]: opts.config ?? JSON.stringify({ rootDir: ".worktrees", copy: [".env"] }) }),
		...(opts.local === undefined ? {} : { [LOCAL_CONFIG_PATH]: opts.local }),
		...(opts.global === undefined ? {} : { [GLOBAL_CONFIG_PATH]: opts.global }),
	};
	const fs = createFakeFilesystem({ files, directories: [ROOT] });
	const git = createFakeGit({ root: ROOT, mainRoot: ROOT, worktrees: [], branches: ["main"] });
	return { fs, git };
}

/** Finds the provenance line for a single config path in the rendered block. */
function fieldLine(block: string | undefined, path: string): string | undefined {
	return plain(block)
		.split("\n")
		.find((line) => line.startsWith(`${path}:`));
}

describe("config show — human output", () => {
	test("renders the sources header and per-field provenance", async () => {
		const { fs, git } = scenario();
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const { code, stdout } = await runConfigShow(container, { json: false });

		expect(code).toBe(0);
		expect(stdout).toEqual([]);
		expect(log.info).toHaveLength(2);

		const header = plain(log.info[0]);
		expect(header).toContain("Sources:");
		expect(header).toContain(`repo:   ${CONFIG_PATH}`);
		expect(header).toContain(`(not found: ${LOCAL_CONFIG_FILENAME})`);

		const body = log.info[1];
		expect(fieldLine(body, "rootDir")).toContain('rootDir: ".worktrees"');
		expect(fieldLine(body, "rootDir")).toContain("← repo");
		expect(fieldLine(body, "copy")).toContain("← repo");
		expect(fieldLine(body, "symlinks")).toContain("← default");
		expect(fieldLine(body, "create.base")).toContain("create.base: (unset)");
		expect(fieldLine(body, "create.base")).toContain("← default");
		expect(log.outro).toEqual(["Done!"]);
	});

	test("local overrides win and are attributed to the local file", async () => {
		const { fs, git } = scenario({ local: JSON.stringify({ rootDir: ".wt" }) });
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const { code } = await runConfigShow(container, { json: false });

		expect(code).toBe(0);
		expect(plain(log.info[0])).toContain(`local:  ${LOCAL_CONFIG_PATH}`);
		expect(fieldLine(log.info[1], "rootDir")).toContain('rootDir: ".wt"');
		expect(fieldLine(log.info[1], "rootDir")).toContain("← local");
	});

	test("global values are attributed to the global file", async () => {
		const { fs, git } = scenario({ global: JSON.stringify({ defaultBase: "default" }) });
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const { code } = await runConfigShow(container, { json: false });

		expect(code).toBe(0);
		expect(plain(log.info[0])).toContain("global:");
		expect(fieldLine(log.info[1], "defaultBase")).toContain('defaultBase: "default"');
		expect(fieldLine(log.info[1], "defaultBase")).toContain("← global");
	});

	test("repo config overrides the global one for the same field", async () => {
		const { fs, git } = scenario({
			config: JSON.stringify({ rootDir: ".worktrees", defaultBase: "current" }),
			global: JSON.stringify({ defaultBase: "default" }),
		});
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const { code } = await runConfigShow(container, { json: false });

		expect(code).toBe(0);
		expect(fieldLine(log.info[1], "defaultBase")).toContain('defaultBase: "current"');
		expect(fieldLine(log.info[1], "defaultBase")).toContain("← repo");
	});

	test("missing config → error exit, nothing rendered", async () => {
		const { fs, git } = scenario({ config: null });
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const { code } = await runConfigShow(container, { json: false });

		expect(code).toBe(EXIT_FAILURE);
		expect(log.error.some((m) => m.includes("Config not found at"))).toBe(true);
		expect(log.info).toEqual([]);
		expect(log.outro).toEqual([]);
	});

	test("invalid config → error exit with the parse message", async () => {
		const { fs, git } = scenario({ config: "{ not json" });
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const { code } = await runConfigShow(container, { json: false });

		expect(code).toBe(EXIT_FAILURE);
		expect(log.error.some((m) => m.includes("Invalid JSONC in"))).toBe(true);
	});
});

describe("config show --json", () => {
	test("writes machine-readable provenance to stdout and skips the prompts UI", async () => {
		const { fs, git } = scenario({ local: JSON.stringify({ copy: [".env.local"] }) });
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const { code, stdout, stderr } = await runConfigShow(container, { json: true });

		expect(code).toBe(0);
		expect(stderr).toEqual([]);
		expect(stdout).toHaveLength(1);
		expect(stdout[0]?.endsWith("\n")).toBe(true);

		const payload = JSON.parse(stdout[0] ?? "") as {
			fields: Record<string, { value: unknown; source: string; sourcePath: string | null }>;
			sources: { global: string | null; repo: string; local: string | null };
		};

		expect(payload.sources).toEqual({ global: null, repo: CONFIG_PATH, local: LOCAL_CONFIG_PATH });
		expect(payload.fields.rootDir).toEqual({ value: ".worktrees", source: "repo", sourcePath: CONFIG_PATH });
		expect(payload.fields.copy).toEqual({ value: [".env.local"], source: "local", sourcePath: LOCAL_CONFIG_PATH });
		// `undefined` is serialized as null so every leaf stays present in the payload.
		expect(payload.fields["create.base"]).toEqual({ value: null, source: "default", sourcePath: null });

		// The JSON branch bypasses the interactive UI entirely.
		expect(log.info).toEqual([]);
		expect(log.outro).toEqual([]);
	});

	test("missing config → JSON error on stderr and a failure exit", async () => {
		const { fs, git } = scenario({ config: null });
		const { ui, log } = createFakeUi();
		const container = buildContainer(ui, git, fs);

		const { code, stdout, stderr } = await runConfigShow(container, { json: true });

		expect(code).toBe(EXIT_FAILURE);
		expect(stdout).toEqual([]);
		const first = JSON.parse(stderr[0] ?? "") as { error: string };
		expect(first.error).toContain("Config not found at");
		expect(log.error).toEqual([]);
	});
});
