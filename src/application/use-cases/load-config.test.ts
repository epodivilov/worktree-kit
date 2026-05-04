import { describe, expect, test } from "bun:test";
import { CONFIG_FILENAME, LEGACY_CONFIG_FILENAME, LOCAL_CONFIG_FILENAME } from "../../domain/constants.ts";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { loadConfig } from "./load-config.ts";

describe("loadConfig", () => {
	const ROOT = "/fake/project";
	const CONFIG_PATH = `${ROOT}/${CONFIG_FILENAME}`;
	const LEGACY_CONFIG_PATH = `${ROOT}/${LEGACY_CONFIG_FILENAME}`;
	const LOCAL_CONFIG_PATH = `${ROOT}/${LOCAL_CONFIG_FILENAME}`;
	const GLOBAL_CONFIG_PATH = "/fake/home/.config/worktree-kit/config.jsonc";

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

	test("applies global config as base for repo config", async () => {
		const repo = JSON.stringify({ rootDir: "../wt" });
		const global = JSON.stringify({ defaultBase: "default", copy: [".env.global"] });
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: repo, [GLOBAL_CONFIG_PATH]: global },
		});
		const git = createFakeGit({ root: ROOT });

		const result = await loadConfig({ fs, git, globalConfigPath: GLOBAL_CONFIG_PATH });
		const { config, globalConfigPath } = expectOk(result);

		expect(config.defaultBase).toBe("default");
		expect(config.copy).toEqual([".env.global"]);
		expect(globalConfigPath).toBe(GLOBAL_CONFIG_PATH);
	});

	test("repo config overrides global config", async () => {
		const repo = JSON.stringify({ rootDir: "../wt", defaultBase: "current", copy: [".env.repo"] });
		const global = JSON.stringify({ defaultBase: "default", copy: [".env.global"] });
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: repo, [GLOBAL_CONFIG_PATH]: global },
		});
		const git = createFakeGit({ root: ROOT });

		const result = await loadConfig({ fs, git, globalConfigPath: GLOBAL_CONFIG_PATH });
		const { config } = expectOk(result);

		expect(config.defaultBase).toBe("current");
		expect(config.copy).toEqual([".env.repo"]);
	});

	test("returns raw per-layer overrides", async () => {
		const global = JSON.stringify({ defaultBase: "default", copy: [".env.global"] });
		const repo = JSON.stringify({ rootDir: "../wt", copy: [".env.repo"] });
		const local = JSON.stringify({ defaultBase: "current" });
		const fs = createFakeFilesystem({
			files: {
				[GLOBAL_CONFIG_PATH]: global,
				[CONFIG_PATH]: repo,
				[LOCAL_CONFIG_PATH]: local,
			},
		});
		const git = createFakeGit({ root: ROOT });

		const result = await loadConfig({ fs, git, globalConfigPath: GLOBAL_CONFIG_PATH });
		const { globalOverrides, repoOverrides, localOverrides } = expectOk(result);

		expect(globalOverrides).toEqual({ defaultBase: "default", copy: [".env.global"] });
		expect(repoOverrides).toEqual({ rootDir: "../wt", copy: [".env.repo"] });
		expect(localOverrides).toEqual({ defaultBase: "current" });
	});

	test("returns null overrides when global and local configs are absent", async () => {
		const repo = JSON.stringify({ rootDir: "../wt" });
		const fs = createFakeFilesystem({ files: { [CONFIG_PATH]: repo } });
		const git = createFakeGit({ root: ROOT });

		const result = await loadConfig({ fs, git, globalConfigPath: GLOBAL_CONFIG_PATH });
		const { globalOverrides, repoOverrides, localOverrides } = expectOk(result);

		expect(globalOverrides).toBeNull();
		expect(repoOverrides).toEqual({ rootDir: "../wt" });
		expect(localOverrides).toBeNull();
	});

	test("merges global, repo, and local in correct order", async () => {
		const global = JSON.stringify({
			defaultBase: "default",
			copy: [".env.global"],
			hooks: { "post-create": ["echo global"] },
		});
		const repo = JSON.stringify({
			rootDir: "../wt",
			copy: [".env.repo"],
			hooks: { "post-update": ["echo repo"] },
		});
		const local = JSON.stringify({
			defaultBase: "current",
			hooks: { "pre-remove": ["echo local"] },
		});
		const fs = createFakeFilesystem({
			files: {
				[GLOBAL_CONFIG_PATH]: global,
				[CONFIG_PATH]: repo,
				[LOCAL_CONFIG_PATH]: local,
			},
		});
		const git = createFakeGit({ root: ROOT });

		const result = await loadConfig({ fs, git, globalConfigPath: GLOBAL_CONFIG_PATH });
		const { config, globalConfigPath, localConfigPath } = expectOk(result);

		expect(config.defaultBase).toBe("current");
		expect(config.copy).toEqual([".env.repo"]);
		expect(config.hooks["post-create"]).toEqual(["echo global"]);
		expect(config.hooks["post-update"]).toEqual(["echo repo"]);
		expect(config.hooks["pre-remove"]).toEqual(["echo local"]);
		expect(globalConfigPath).toBe(GLOBAL_CONFIG_PATH);
		expect(localConfigPath).toBe(LOCAL_CONFIG_PATH);
	});

	test("missing global config is not an error", async () => {
		const repo = JSON.stringify({ rootDir: "../wt" });
		const fs = createFakeFilesystem({ files: { [CONFIG_PATH]: repo } });
		const git = createFakeGit({ root: ROOT });

		const result = await loadConfig({ fs, git, globalConfigPath: GLOBAL_CONFIG_PATH });
		const { config, globalConfigPath } = expectOk(result);

		expect(config.rootDir).toBe("../wt");
		expect(globalConfigPath).toBeNull();
	});

	test("returns error for invalid JSONC in global config", async () => {
		const repo = JSON.stringify({ rootDir: "../wt" });
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: repo, [GLOBAL_CONFIG_PATH]: "not json {{{" },
		});
		const git = createFakeGit({ root: ROOT });

		const result = await loadConfig({ fs, git, globalConfigPath: GLOBAL_CONFIG_PATH });
		const error = expectErr(result);

		expect(error.message).toContain("Invalid JSONC");
		expect(error.message).toContain(GLOBAL_CONFIG_PATH);
	});

	test("returns error for invalid schema in global config", async () => {
		const repo = JSON.stringify({ rootDir: "../wt" });
		const global = JSON.stringify({ defaultBase: "not-a-valid-value" });
		const fs = createFakeFilesystem({
			files: { [CONFIG_PATH]: repo, [GLOBAL_CONFIG_PATH]: global },
		});
		const git = createFakeGit({ root: ROOT });

		const result = await loadConfig({ fs, git, globalConfigPath: GLOBAL_CONFIG_PATH });
		const error = expectErr(result);

		expect(error.message).toContain("Invalid global config");
	});
});
