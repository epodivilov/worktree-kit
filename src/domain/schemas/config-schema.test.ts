import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { WorktreeConfigSchema } from "./config-schema.ts";

describe("WorktreeConfigSchema", () => {
	test("valid full config parses correctly", () => {
		const input = { rootDir: "../wt", copy: [".env", ".env.local"] };
		const result = v.safeParse(WorktreeConfigSchema, input);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.rootDir).toBe("../wt");
			expect(result.output.copy).toEqual([".env", ".env.local"]);
			expect(result.output.hooks).toEqual({ "post-create": [], "pre-remove": [] });
		}
	});

	test("valid config with hooks parses correctly", () => {
		const input = {
			rootDir: "../wt",
			copy: [".env"],
			hooks: { "post-create": ["pnpm install", "cp .env.example .env"] },
		};
		const result = v.safeParse(WorktreeConfigSchema, input);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.hooks["post-create"]).toEqual(["pnpm install", "cp .env.example .env"]);
		}
	});

	test("config without copy defaults to empty array", () => {
		const result = v.safeParse(WorktreeConfigSchema, { rootDir: "../wt" });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.rootDir).toBe("../wt");
			expect(result.output.copy).toEqual([]);
		}
	});

	test("config without hooks defaults to empty post-create", () => {
		const result = v.safeParse(WorktreeConfigSchema, { rootDir: "../wt" });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.hooks).toEqual({ "post-create": [], "pre-remove": [] });
		}
	});

	test("config with empty hooks object defaults post-create", () => {
		const result = v.safeParse(WorktreeConfigSchema, { rootDir: "../wt", hooks: {} });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.hooks).toEqual({ "post-create": [], "pre-remove": [] });
		}
	});

	test("rejects non-string items in hooks.post-create", () => {
		const result = v.safeParse(WorktreeConfigSchema, {
			rootDir: "../wt",
			hooks: { "post-create": [123] },
		});
		expect(result.success).toBe(false);
	});

	test("rejects config without rootDir", () => {
		const result = v.safeParse(WorktreeConfigSchema, { copy: [".env"] });
		expect(result.success).toBe(false);
	});

	test("rejects empty object", () => {
		const result = v.safeParse(WorktreeConfigSchema, {});
		expect(result.success).toBe(false);
	});

	test("rejects non-string rootDir", () => {
		const result = v.safeParse(WorktreeConfigSchema, { rootDir: 123 });
		expect(result.success).toBe(false);
	});

	test("rejects non-string items in copy", () => {
		const result = v.safeParse(WorktreeConfigSchema, { rootDir: "../wt", copy: [123] });
		expect(result.success).toBe(false);
	});

	test("rejects non-object input", () => {
		const result = v.safeParse(WorktreeConfigSchema, "not an object");
		expect(result.success).toBe(false);
	});

	test("config without defaultBase defaults to ask", () => {
		const result = v.safeParse(WorktreeConfigSchema, { rootDir: "../wt" });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.defaultBase).toBe("ask");
		}
	});

	test("config with valid defaultBase values parses correctly", () => {
		for (const value of ["current", "default", "ask"] as const) {
			const result = v.safeParse(WorktreeConfigSchema, { rootDir: "../wt", defaultBase: value });
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.output.defaultBase).toBe(value);
			}
		}
	});

	test("rejects invalid defaultBase value", () => {
		const result = v.safeParse(WorktreeConfigSchema, { rootDir: "../wt", defaultBase: "invalid" });
		expect(result.success).toBe(false);
	});

	test("config without create/remove sections defaults to empty objects", () => {
		const result = v.safeParse(WorktreeConfigSchema, { rootDir: "../wt" });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.create).toEqual({ base: undefined });
			expect(result.output.remove).toEqual({
				deleteBranch: undefined,
				deleteRemoteBranch: undefined,
			});
		}
	});

	test("config with create.base parses correctly", () => {
		const result = v.safeParse(WorktreeConfigSchema, {
			rootDir: "../wt",
			create: { base: "main" },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.create.base).toBe("main");
		}
	});

	test("config with remove options parses correctly", () => {
		const result = v.safeParse(WorktreeConfigSchema, {
			rootDir: "../wt",
			remove: { deleteBranch: true },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.remove.deleteBranch).toBe(true);
		}
	});

	test("rejects non-boolean remove.deleteBranch", () => {
		const result = v.safeParse(WorktreeConfigSchema, {
			rootDir: "../wt",
			remove: { deleteBranch: "yes" },
		});
		expect(result.success).toBe(false);
	});
});
