import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { expectErr, expectOk } from "../../test-utils/assertions.ts";
import { createNoopLogger } from "../../test-utils/noop-logger.ts";
import { createTempDir } from "../../test-utils/temp-dir.ts";
import { createBunFilesystemAdapter } from "./bun-filesystem-adapter.ts";

describe("BunFilesystemAdapter", () => {
	const fs = createBunFilesystemAdapter(createNoopLogger());

	test("writeFile then readFile roundtrips content", async () => {
		await using tmp = await createTempDir();
		const filePath = join(tmp.path, "test.txt");

		expectOk(await fs.writeFile(filePath, "hello world"));
		const content = expectOk(await fs.readFile(filePath));
		expect(content).toBe("hello world");
	});

	test("exists returns true for existing file, false for missing", async () => {
		await using tmp = await createTempDir();
		const filePath = join(tmp.path, "exists-test.txt");

		expect(await fs.exists(filePath)).toBe(false);
		await fs.writeFile(filePath, "data");
		expect(await fs.exists(filePath)).toBe(true);
	});

	test("readFile returns NOT_FOUND error for missing file", async () => {
		await using tmp = await createTempDir();

		const error = expectErr(await fs.readFile(join(tmp.path, "nope.txt")));
		expect(error.code).toBe("NOT_FOUND");
	});

	test("copyFile copies content from source to destination", async () => {
		await using tmp = await createTempDir();
		const src = join(tmp.path, "src.txt");
		const dst = join(tmp.path, "dst.txt");

		await fs.writeFile(src, "copied content");
		expectOk(await fs.copyFile(src, dst));
		const content = expectOk(await fs.readFile(dst));
		expect(content).toBe("copied content");
	});
});
