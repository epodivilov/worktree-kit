import { describe, expect, it } from "bun:test";
import { deepMerge } from "./deep-merge.ts";

describe("deepMerge", () => {
	it("merges nested objects recursively", () => {
		const base = { a: { b: 1, c: 2 }, d: 3 };
		const override = { a: { b: 10 } };

		const result = deepMerge(base, override);

		expect(result).toEqual({ a: { b: 10, c: 2 }, d: 3 });
	});

	it("replaces arrays entirely (override wins)", () => {
		const base = { items: [1, 2, 3], name: "test" };
		const override = { items: [4, 5] };

		const result = deepMerge(base, override);

		expect(result).toEqual({ items: [4, 5], name: "test" });
	});

	it("skips undefined values in override", () => {
		const base = { a: 1, b: 2 };
		const override = { a: undefined, b: 3 };

		const result = deepMerge(base, override);

		expect(result).toEqual({ a: 1, b: 3 });
	});

	it("replaces primitive values", () => {
		const base = { a: 1, b: "hello", c: true };
		const override = { a: 99, b: "world", c: false };

		const result = deepMerge(base, override);

		expect(result).toEqual({ a: 99, b: "world", c: false });
	});

	it("replaces base values with null from override", () => {
		const base = { a: { nested: 1 }, b: "keep" } as { a: { nested: number } | null; b: string };
		const override = { a: null };

		const result = deepMerge(base, override);

		expect(result).toEqual({ a: null, b: "keep" });
	});

	it("returns a copy of base when override is empty", () => {
		const base = { a: 1, b: { c: 2 } };
		const override = {};

		const result = deepMerge(base, override);

		expect(result).toEqual({ a: 1, b: { c: 2 } });
		expect(result).not.toBe(base);
	});

	it("deeply merges multiple levels", () => {
		const base = { l1: { l2: { l3: { value: "original", keep: true } } } };
		const override = { l1: { l2: { l3: { value: "replaced" } } } };

		const result = deepMerge(base, override);

		expect(result).toEqual({ l1: { l2: { l3: { value: "replaced", keep: true } } } });
	});

	it("replaces base array with override object when types differ", () => {
		const base = { data: [1, 2] } as { data: number[] | { key: string } };
		const override = { data: { key: "value" } };

		const result = deepMerge(base, override);

		expect(result).toEqual({ data: { key: "value" } });
	});

	it("silently adds extra keys from override not present in base", () => {
		const base = { a: 1 };
		const override = { b: 2 } as Record<string, unknown>;

		const result = deepMerge(base, override);

		expect((result as Record<string, unknown>).b).toBe(2);
		expect(result.a).toBe(1);
	});

	it("does not mutate the base object", () => {
		const base = { a: { b: 1 } };
		const override = { a: { b: 2 } };

		deepMerge(base, override);

		expect(base).toEqual({ a: { b: 1 } });
	});
});
