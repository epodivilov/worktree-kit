import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONFIG_FILENAME } from "../../domain/constants.ts";
import type { UiPort } from "../../domain/ports/ui-port.ts";
import type { Container } from "../../infrastructure/container.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit, type FakeGitOptions } from "../../test-utils/fake-git.ts";
import { initCommand } from "./init.ts";

const ROOT = "/fake/project";
const CONFIG_PATH = `${ROOT}/${CONFIG_FILENAME}`;
const CANCEL_SYMBOL = Symbol("cancel");

interface FakeUiLog {
	success: string[];
	error: string[];
	warn: string[];
	outro: string[];
}

interface FakeUiOptions {
	nonInteractive?: boolean;
	/** Response for ui.confirm. */
	confirm?: boolean | symbol;
	/** Response for ui.select (value to return). */
	select?: string | symbol;
}

function createFakeUi(opts: FakeUiOptions = {}): {
	ui: UiPort;
	log: FakeUiLog;
	confirmMessages: string[];
	selectCalls: { message: string; values: string[] }[];
} {
	const log: FakeUiLog = { success: [], error: [], warn: [], outro: [] };
	const confirmMessages: string[] = [];
	const selectCalls: { message: string; values: string[] }[] = [];
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

async function runInit(container: Container, args: Record<string, unknown>): Promise<number> {
	const cmd = initCommand(container);
	const run = cmd.run as (ctx: { args: Record<string, unknown>; cmd: unknown; rawArgs: string[] }) => Promise<void>;
	try {
		await run({ args, cmd, rawArgs: [] });
		return recordedExit ?? 0;
	} catch (err) {
		if (err instanceof ExitSignal) return recordedExit ?? err.code;
		throw err;
	}
}

const BASE_ARGS = { force: false, migrate: false, local: false, upstream: undefined };

function scenario(gitOptions: FakeGitOptions, uiOptions: FakeUiOptions = {}) {
	const fs = createFakeFilesystem();
	const git = createFakeGit({ root: ROOT, ...gitOptions });
	const fake = createFakeUi(uiOptions);
	const container = buildContainer(fake.ui, git, fs);
	return { fs, git, container, ...fake };
}

async function readConfig(fs: ReturnType<typeof createFakeFilesystem>): Promise<Record<string, unknown>> {
	const read = await fs.readFile(CONFIG_PATH);
	if (!read.success) throw new Error("config not written");
	return JSON.parse(read.data);
}

describe("init upstream detection", () => {
	test("single non-origin remote, confirm yes → records the name", async () => {
		const { fs, container, confirmMessages } = scenario({ remotes: ["origin", "upstream"] }, { confirm: true });

		const code = await runInit(container, BASE_ARGS);

		expect(code).toBe(0);
		expect(confirmMessages.some((m) => m.includes("upstream"))).toBe(true);
		const config = await readConfig(fs);
		expect(config.upstream).toBe("upstream");
	});

	test("single non-origin remote, confirm no → no upstream recorded", async () => {
		const { fs, container } = scenario({ remotes: ["origin", "upstream"] }, { confirm: false });

		const code = await runInit(container, BASE_ARGS);

		expect(code).toBe(0);
		const config = await readConfig(fs);
		expect(config.upstream).toBeUndefined();
	});

	test("multiple non-origin remotes → select chooses the name", async () => {
		const { fs, container, selectCalls } = scenario(
			{ remotes: ["origin", "upstream", "mirror"] },
			{ select: "mirror" },
		);

		const code = await runInit(container, BASE_ARGS);

		expect(code).toBe(0);
		expect(selectCalls).toHaveLength(1);
		expect(selectCalls[0]?.values).toContain("upstream");
		expect(selectCalls[0]?.values).toContain("mirror");
		const config = await readConfig(fs);
		expect(config.upstream).toBe("mirror");
	});

	test("multiple remotes → select 'Don't configure' → no upstream", async () => {
		const { fs, container } = scenario({ remotes: ["origin", "upstream", "mirror"] }, { select: "__skip__" });

		const code = await runInit(container, BASE_ARGS);

		expect(code).toBe(0);
		const config = await readConfig(fs);
		expect(config.upstream).toBeUndefined();
	});

	test("no non-origin remotes → no upstream, no prompt", async () => {
		const { fs, container, confirmMessages } = scenario({ remotes: ["origin"] });

		const code = await runInit(container, BASE_ARGS);

		expect(code).toBe(0);
		expect(confirmMessages).toEqual([]);
		const config = await readConfig(fs);
		expect(config.upstream).toBeUndefined();
	});

	test("non-interactive without --upstream → no detection, no upstream", async () => {
		const { fs, container, confirmMessages, selectCalls } = scenario(
			{ remotes: ["origin", "upstream"] },
			{ nonInteractive: true },
		);

		const code = await runInit(container, BASE_ARGS);

		expect(code).toBe(0);
		expect(confirmMessages).toEqual([]);
		expect(selectCalls).toEqual([]);
		const config = await readConfig(fs);
		expect(config.upstream).toBeUndefined();
	});
});

describe("init --upstream <url>", () => {
	const URL = "https://github.com/orig/repo.git";

	test("new remote → adds it and records upstream:'upstream'", async () => {
		const addRemoteCalls: { name: string; url: string }[] = [];
		const { fs, container } = scenario({ remotes: ["origin"], addRemoteCalls });

		const code = await runInit(container, { ...BASE_ARGS, upstream: URL });

		expect(code).toBe(0);
		expect(addRemoteCalls).toEqual([{ name: "upstream", url: URL }]);
		const config = await readConfig(fs);
		expect(config.upstream).toBe("upstream");
	});

	test("existing remote with same URL → no mutation", async () => {
		const addRemoteCalls: { name: string; url: string }[] = [];
		const setRemoteUrlCalls: { name: string; url: string }[] = [];
		const { fs, container } = scenario({
			remotes: ["origin", "upstream"],
			remoteUrls: new Map([["upstream", URL]]),
			addRemoteCalls,
			setRemoteUrlCalls,
		});

		const code = await runInit(container, { ...BASE_ARGS, upstream: URL });

		expect(code).toBe(0);
		expect(addRemoteCalls).toEqual([]);
		expect(setRemoteUrlCalls).toEqual([]);
		const config = await readConfig(fs);
		expect(config.upstream).toBe("upstream");
	});

	test("existing remote, different URL, interactive yes → setRemoteUrl called", async () => {
		const setRemoteUrlCalls: { name: string; url: string }[] = [];
		const { fs, container } = scenario(
			{
				remotes: ["origin", "upstream"],
				remoteUrls: new Map([["upstream", "https://github.com/old/repo.git"]]),
				setRemoteUrlCalls,
			},
			{ confirm: true },
		);

		const code = await runInit(container, { ...BASE_ARGS, upstream: URL });

		expect(code).toBe(0);
		expect(setRemoteUrlCalls).toEqual([{ name: "upstream", url: URL }]);
		const config = await readConfig(fs);
		expect(config.upstream).toBe("upstream");
	});

	test("existing remote, different URL, interactive no → kept, no setRemoteUrl", async () => {
		const setRemoteUrlCalls: { name: string; url: string }[] = [];
		const { fs, container } = scenario(
			{
				remotes: ["origin", "upstream"],
				remoteUrls: new Map([["upstream", "https://github.com/old/repo.git"]]),
				setRemoteUrlCalls,
			},
			{ confirm: false },
		);

		const code = await runInit(container, { ...BASE_ARGS, upstream: URL });

		expect(code).toBe(0);
		expect(setRemoteUrlCalls).toEqual([]);
		const config = await readConfig(fs);
		expect(config.upstream).toBe("upstream");
	});

	test("non-interactive, different URL, no --force → kept + warn, no setRemoteUrl", async () => {
		const setRemoteUrlCalls: { name: string; url: string }[] = [];
		const { fs, container, log } = scenario(
			{
				remotes: ["origin", "upstream"],
				remoteUrls: new Map([["upstream", "https://github.com/old/repo.git"]]),
				setRemoteUrlCalls,
			},
			{ nonInteractive: true },
		);

		const code = await runInit(container, { ...BASE_ARGS, upstream: URL });

		expect(code).toBe(0);
		expect(setRemoteUrlCalls).toEqual([]);
		expect(log.warn.some((m) => m.includes("--force"))).toBe(true);
		const config = await readConfig(fs);
		expect(config.upstream).toBe("upstream");
	});

	test("non-interactive, different URL, with --force → setRemoteUrl called", async () => {
		const setRemoteUrlCalls: { name: string; url: string }[] = [];
		const { fs, container } = scenario(
			{
				remotes: ["origin", "upstream"],
				remoteUrls: new Map([["upstream", "https://github.com/old/repo.git"]]),
				setRemoteUrlCalls,
			},
			{ nonInteractive: true },
		);

		const code = await runInit(container, { ...BASE_ARGS, force: true, upstream: URL });

		expect(code).toBe(0);
		expect(setRemoteUrlCalls).toEqual([{ name: "upstream", url: URL }]);
		const config = await readConfig(fs);
		expect(config.upstream).toBe("upstream");
	});
});
