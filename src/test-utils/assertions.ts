import { expect } from "bun:test";
import type { Result } from "../shared/result.ts";

export function expectOk<T, E>(result: Result<T, E>): T {
	expect(result.success).toBe(true);
	if (!result.success) throw new Error("unreachable");
	return result.data;
}

export function expectErr<T, E>(result: Result<T, E>): E {
	expect(result.success).toBe(false);
	if (result.success) throw new Error("unreachable");
	return result.error;
}
