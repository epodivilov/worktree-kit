import { describe, expect, test } from "bun:test";
import { CONFIG_FILENAME } from "../../domain/constants.ts";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { createFakeGit } from "../../test-utils/fake-git.ts";
import { loadConfig } from "./load-config.ts";

describe("loadConfig", () => {
	const ROOT = "/fake/project";
	const CONFIG_PATH = `${ROOT}/${CONFIG_FILENAME}`;

	test("loads config from repo root", async () => {
		const content = JSON.stringify({ rootDir: "../wt", copy: [".env"] });
		const fs = createFakeFilesystem({ files: { [CONFIG_PATH]: content } });
		const git = createFakeGit({ root: ROOT });

		const result = await loadConfig({ fs, git });
		const { config, configPath } = expectOk(result);

		expect(config.rootDir).toBe("../wt");
		expect(config.copy).toEqual([".env"]);
		expect(configPath).toBe(CONFIG_PATH);
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

		expect(error.message).toContain("Invalid JSON");
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
});
