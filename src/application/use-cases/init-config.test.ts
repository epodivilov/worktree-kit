import { describe, expect, test } from "bun:test";
import { Result } from "../../shared/result.ts";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { initConfig } from "./init-config.ts";

describe("initConfig", () => {
	const CONFIG_FILENAME = ".worktree.json";

	test("creates .worktree.json in cwd with default content", async () => {
		const fs = createFakeFilesystem({ cwd: "/fake/project" });
		const result = await initConfig({}, { fs });

		const { configPath } = expectOk(result);
		expect(configPath).toBe(`/fake/project/${CONFIG_FILENAME}`);
		expect(await fs.exists(configPath)).toBe(true);

		const parsed = JSON.parse(expectOk(await fs.readFile(configPath)));
		expect(parsed.files).toEqual([]);
		expect(parsed.directories).toEqual([]);
		expect(parsed.ignore).toEqual(["node_modules", ".git"]);
	});

	test("returns error when config already exists and force is false", async () => {
		const configPath = `/fake/project/${CONFIG_FILENAME}`;
		const fs = createFakeFilesystem({ files: { [configPath]: '{"files": []}' }, cwd: "/fake/project" });
		const result = await initConfig({}, { fs });

		const error = expectErr(result);
		expect(error.message).toContain("already exists");
	});

	test("overwrites existing config when force is true", async () => {
		const configPath = `/fake/project/${CONFIG_FILENAME}`;
		const fs = createFakeFilesystem({ files: { [configPath]: '{"files": ["old"]}' }, cwd: "/fake/project" });
		const result = await initConfig({ force: true }, { fs });

		expectOk(result);
		const parsed = JSON.parse(expectOk(await fs.readFile(configPath)));
		expect(parsed.files).toEqual([]);
	});

	test("returns the full config path based on cwd", async () => {
		const fs = createFakeFilesystem({ cwd: "/some/other/dir" });
		const result = await initConfig({}, { fs });

		const { configPath } = expectOk(result);
		expect(configPath).toBe(`/some/other/dir/${CONFIG_FILENAME}`);
	});

	test("returns error when writeFile fails", async () => {
		const fs = createFakeFilesystem({
			cwd: "/fake/project",
			overrides: {
				writeFile: async (path) =>
					Result.err({ code: "PERMISSION_DENIED" as const, message: "Permission denied", path }),
			},
		});
		const result = await initConfig({}, { fs });

		expectErr(result);
	});
});
