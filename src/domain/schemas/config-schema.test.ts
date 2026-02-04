import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { WorktreeConfigSchema } from "./config-schema.ts";

describe("WorktreeConfigSchema", () => {
	test("valid full config parses correctly", () => {
		const input = {
			files: [".env", ".env.local"],
			directories: ["config"],
			ignore: ["node_modules", "dist"],
		};
		const result = v.safeParse(WorktreeConfigSchema, input);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.files).toEqual([".env", ".env.local"]);
			expect(result.output.directories).toEqual(["config"]);
			expect(result.output.ignore).toEqual(["node_modules", "dist"]);
		}
	});

	test("empty object gets all defaults", () => {
		const result = v.safeParse(WorktreeConfigSchema, {});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.files).toEqual([]);
			expect(result.output.directories).toEqual([]);
			expect(result.output.ignore).toEqual(["node_modules", ".git"]);
		}
	});

	test("partial config fills missing fields with defaults", () => {
		const result = v.safeParse(WorktreeConfigSchema, { files: [".env"] });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.files).toEqual([".env"]);
			expect(result.output.directories).toEqual([]);
			expect(result.output.ignore).toEqual(["node_modules", ".git"]);
		}
	});

	test("rejects non-string array items in files", () => {
		const result = v.safeParse(WorktreeConfigSchema, { files: [123] });
		expect(result.success).toBe(false);
	});

	test("rejects non-object input", () => {
		const result = v.safeParse(WorktreeConfigSchema, "not an object");
		expect(result.success).toBe(false);
	});
});
