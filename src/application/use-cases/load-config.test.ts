import { describe, expect, test } from "bun:test";
import { CONFIG_FILENAME, LEGACY_CONFIG_FILENAME } from "../../domain/constants.ts";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { loadConfig } from "./load-config.ts";

describe("loadConfig", () => {
	const ROOT = "/fake/project";
	const CONFIG_PATH = `${ROOT}/${CONFIG_FILENAME}`;
	const LEGACY_CONFIG_PATH = `${ROOT}/${LEGACY_CONFIG_FILENAME}`;

	test("loads config from repo root", async () => {
		const content = JSON.stringify({ rootDir: "../wt", copy: [".env"] });
		const fs = createFakeFilesystem({ files: { [CONFIG_PATH]: content } });
		const git = createFakeGit({ root: ROOT });

		const result = await loadConfig({ fs, git });
		const { config, configPath, isLegacyConfig } = expectOk(result);

		expect(config.rootDir).toBe("../wt");
		expect(config.copy).toEqual([".env"]);
		expect(configPath).toBe(CONFIG_PATH);
		expect(isLegacyConfig).toBe(false);
	});

	test("defaults copy to empty array when not specified", async () => {
		const content = JSON.stringify({ rootDir: "../wt" });
		const fs = createFakeFilesystem({ files: { [CONFIG_PATH]: content } });
		const git = createFakeGit({ root: ROOT });

		const result = await loadConfig({ fs, git });
		const { config } = expectOk(result);

		expect(config.copy).toEqual([]);
	});

	test("returns error when config not found", async () => {
		const fs = createFakeFilesystem();
		const git = createFakeGit({ root: ROOT });

		const result = await loadConfig({ fs, git });
		const error = expectErr(result);

		expect(error.message).toContain("Config not found");
		expect(error.message).toContain("wt init");
	});

	test("returns error for invalid JSON", async () => {
		const fs = createFakeFilesystem({ files: { [CONFIG_PATH]: "not json {{{" } });
		const git = createFakeGit({ root: ROOT });

		const result = await loadConfig({ fs, git });
		const error = expectErr(result);

		expect(error.message).toContain("Invalid JSONC");
	});

	test("returns error when rootDir is missing", async () => {
		const content = JSON.stringify({ copy: [".env"] });
		const fs = createFakeFilesystem({ files: { [CONFIG_PATH]: content } });
		const git = createFakeGit({ root: ROOT });

		const result = await loadConfig({ fs, git });
		const error = expectErr(result);

		expect(error.message).toContain("Invalid config");
	});

	test("returns error when not a git repository", async () => {
		const fs = createFakeFilesystem();
		const git = createFakeGit({ isRepo: false });

		const result = await loadConfig({ fs, git });
		const error = expectErr(result);

		expect(error.message).toContain("Not a git repository");
	});

	test("loads config from main worktree when in linked worktree", async () => {
		const MAIN_ROOT = "/fake/main-project";
		const LINKED_ROOT = "/fake/worktrees/feature";
		const content = JSON.stringify({ rootDir: "../wt", copy: [".env"] });
		const fs = createFakeFilesystem({ files: { [`${MAIN_ROOT}/${CONFIG_FILENAME}`]: content } });
		const git = createFakeGit({ root: LINKED_ROOT, mainRoot: MAIN_ROOT });

		const result = await loadConfig({ fs, git });
		const { config, configPath } = expectOk(result);

		expect(config.rootDir).toBe("../wt");
		expect(configPath).toBe(`${MAIN_ROOT}/${CONFIG_FILENAME}`);
	});

	test("falls back to legacy config when new config not found", async () => {
		const content = JSON.stringify({ rootDir: "../wt", copy: [".env"] });
		const fs = createFakeFilesystem({ files: { [LEGACY_CONFIG_PATH]: content } });
		const git = createFakeGit({ root: ROOT });

		const result = await loadConfig({ fs, git });
		const { config, configPath, isLegacyConfig } = expectOk(result);

		expect(config.rootDir).toBe("../wt");
		expect(configPath).toBe(LEGACY_CONFIG_PATH);
		expect(isLegacyConfig).toBe(true);
	});

	test("prefers new config over legacy when both exist", async () => {
		const newContent = JSON.stringify({ rootDir: "../new" });
		const legacyContent = JSON.stringify({ rootDir: "../old" });
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: newContent, [LEGACY_CONFIG_PATH]: legacyContent },
		});
		const git = createFakeGit({ root: ROOT });

		const result = await loadConfig({ fs, git });
		const { config, isLegacyConfig } = expectOk(result);

		expect(config.rootDir).toBe("../new");
		expect(isLegacyConfig).toBe(false);
	});

	test("parses JSONC with comments", async () => {
		const content = `{
			// This is a comment
			"rootDir": "../wt",
			"copy": [".env"] /* inline comment */
		}`;
		const fs = createFakeFilesystem({ files: { [CONFIG_PATH]: content } });
		const git = createFakeGit({ root: ROOT });

		const result = await loadConfig({ fs, git });
		const { config } = expectOk(result);

		expect(config.rootDir).toBe("../wt");
		expect(config.copy).toEqual([".env"]);
	});
});
