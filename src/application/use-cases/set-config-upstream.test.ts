import { describe, expect, test } from "bun:test";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import { setConfigUpstream } from "./set-config-upstream.ts";

const PATH = "/fake/project/.worktreekit.jsonc";

async function read(fs: ReturnType<typeof createFakeFilesystem>): Promise<string> {
	const result = await fs.readFile(PATH);
	if (!result.success) throw new Error("config not written");
	return result.data;
}

describe("setConfigUpstream", () => {
	test("inserts a string value after $schema", async () => {
		const fs = createFakeFilesystem({
			files: {
				[PATH]: '{\n\t"$schema": "https://example.com/schema.json",\n\t"rootDir": ".worktrees"\n}\n',
			},
		});

		const result = await setConfigUpstream({ configPath: PATH, value: "upstream" }, { fs });

		expect(result.success).toBe(true);
		const content = await read(fs);
		expect(content).toContain('"upstream": "upstream"');
		// $schema is preserved and the new key sits right after it.
		expect(content).toMatch(/"\$schema":[^\n]*\n\t"upstream": "upstream",/);
		expect(JSON.parse(content).upstream).toBe("upstream");
	});

	test("inserts false unquoted", async () => {
		const fs = createFakeFilesystem({
			files: { [PATH]: '{\n\t"rootDir": ".worktrees"\n}\n' },
		});

		const result = await setConfigUpstream({ configPath: PATH, value: false }, { fs });

		expect(result.success).toBe(true);
		const content = await read(fs);
		expect(content).toContain('"upstream": false');
		expect(content).not.toContain('"upstream": "false"');
		expect(JSON.parse(content).upstream).toBe(false);
	});

	test("preserves an existing comment", async () => {
		const fs = createFakeFilesystem({
			files: {
				[PATH]: '{\n\t// keep me\n\t"rootDir": ".worktrees"\n}\n',
			},
		});

		const result = await setConfigUpstream({ configPath: PATH, value: "fork" }, { fs });

		expect(result.success).toBe(true);
		const content = await read(fs);
		expect(content).toContain("// keep me");
		expect(content).toContain('"upstream": "fork"');
	});

	test("replaces an existing upstream key", async () => {
		const fs = createFakeFilesystem({
			files: {
				[PATH]: '{\n\t"rootDir": ".worktrees",\n\t"upstream": "old"\n}\n',
			},
		});

		const result = await setConfigUpstream({ configPath: PATH, value: "new" }, { fs });

		expect(result.success).toBe(true);
		const content = await read(fs);
		expect(content).toContain('"upstream": "new"');
		expect(content).not.toContain('"old"');
		// No duplicate key was inserted.
		expect(content.match(/"upstream"/g)).toHaveLength(1);
	});

	test("replaces an existing upstream key with false", async () => {
		const fs = createFakeFilesystem({
			files: {
				[PATH]: '{\n\t"rootDir": ".worktrees",\n\t"upstream": "old"\n}\n',
			},
		});

		const result = await setConfigUpstream({ configPath: PATH, value: false }, { fs });

		expect(result.success).toBe(true);
		const content = await read(fs);
		expect(content).toContain('"upstream": false');
		expect(JSON.parse(content).upstream).toBe(false);
	});
});
