import { describe, expect, test } from "bun:test";
import { CONFIG_FILENAME, INIT_ROOT_DIR, LEGACY_CONFIG_FILENAME } from "../../domain/constants.ts";
import { Result } from "../../shared/result.ts";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { initConfig } from "./init-config.ts";

describe("initConfig", () => {
	const ROOT = "/fake/project";
	const CONFIG_PATH = `${ROOT}/${CONFIG_FILENAME}`;
	const LEGACY_CONFIG_PATH = `${ROOT}/${LEGACY_CONFIG_FILENAME}`;

	test("creates config in repo root with default content", async () => {
		const fs = createFakeFilesystem();
		const git = createFakeGit({ root: ROOT });
		const result = await initConfig({}, { fs, git });

		const { configPath } = expectOk(result);
		expect(configPath).toBe(CONFIG_PATH);
		expect(await fs.exists(configPath)).toBe(true);

		const parsed = JSON.parse(expectOk(await fs.readFile(configPath)));
		expect(parsed.rootDir).toBe(INIT_ROOT_DIR);
		expect(parsed.copy).toEqual([]);
	});

	test("returns error when config already exists and force is false", async () => {
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: '{"rootDir": "../wt"}' },
		});
		const git = createFakeGit({ root: ROOT });
		const result = await initConfig({}, { fs, git });

		const error = expectErr(result);
		expect(error.message).toContain("already exists");
	});

	test("overwrites existing config when force is true", async () => {
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: '{"rootDir": "../old"}' },
		});
		const git = createFakeGit({ root: ROOT });
		const result = await initConfig({ force: true }, { fs, git });

		expectOk(result);
		const parsed = JSON.parse(expectOk(await fs.readFile(CONFIG_PATH)));
		expect(parsed.rootDir).toBe(INIT_ROOT_DIR);
	});

	test("returns error when not a git repository", async () => {
		const fs = createFakeFilesystem();
		const git = createFakeGit({ isRepo: false });
		const result = await initConfig({}, { fs, git });

		const error = expectErr(result);
		expect(error.message).toContain("Not a git repository");
	});

	test("returns error when writeFile fails", async () => {
		const fs = createFakeFilesystem({
			overrides: {
				writeFile: async (path) =>
					Result.err({
						code: "PERMISSION_DENIED" as const,
						message: "Permission denied",
						path,
					}),
			},
		});
		const git = createFakeGit({ root: ROOT });
		const result = await initConfig({}, { fs, git });

		expectErr(result);
	});

	test("creates config in main worktree when in linked worktree", async () => {
		const MAIN_ROOT = "/fake/main-project";
		const LINKED_ROOT = "/fake/worktrees/feature";
		const MAIN_CONFIG_PATH = `${MAIN_ROOT}/${CONFIG_FILENAME}`;
		const fs = createFakeFilesystem();
		const git = createFakeGit({ root: LINKED_ROOT, mainRoot: MAIN_ROOT });
		const result = await initConfig({}, { fs, git });

		const { configPath } = expectOk(result);
		expect(configPath).toBe(MAIN_CONFIG_PATH);
		expect(await fs.exists(MAIN_CONFIG_PATH)).toBe(true);
	});

	test("migrate renames legacy config to new name", async () => {
		const legacyContent = '{"rootDir": "../wt", "copy": [".env"]}';
		const fs = createFakeFilesystem({
			files: { [LEGACY_CONFIG_PATH]: legacyContent },
		});
		const git = createFakeGit({ root: ROOT });
		const result = await initConfig({ migrate: true }, { fs, git });

		const { configPath } = expectOk(result);
		expect(configPath).toBe(CONFIG_PATH);
		expect(await fs.exists(CONFIG_PATH)).toBe(true);
		expect(await fs.exists(LEGACY_CONFIG_PATH)).toBe(false);

		const content = expectOk(await fs.readFile(CONFIG_PATH));
		expect(JSON.parse(content).rootDir).toBe("../wt");
	});

	test("migrate returns error when legacy config not found", async () => {
		const fs = createFakeFilesystem();
		const git = createFakeGit({ root: ROOT });
		const result = await initConfig({ migrate: true }, { fs, git });

		const error = expectErr(result);
		expect(error.message).toContain("Legacy config not found");
	});

	test("migrate returns error when new config already exists", async () => {
		const fs = createFakeFilesystem({
			files: {
				[LEGACY_CONFIG_PATH]: '{"rootDir": "../wt"}',
				[CONFIG_PATH]: '{"rootDir": "../new"}',
			},
		});
		const git = createFakeGit({ root: ROOT });
		const result = await initConfig({ migrate: true }, { fs, git });

		const error = expectErr(result);
		expect(error.message).toContain("New config already exists");
	});
});
