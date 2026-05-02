import { describe, expect, test } from "bun:test";
import { resolveGlobalConfigPath } from "./xdg-paths.ts";

describe("resolveGlobalConfigPath", () => {
	test("uses XDG_CONFIG_HOME when set", () => {
		const path = resolveGlobalConfigPath({
			env: { XDG_CONFIG_HOME: "/custom/config" } as NodeJS.ProcessEnv,
			homedir: () => "/home/user",
		});

		expect(path).toBe("/custom/config/worktree-kit/config.jsonc");
	});

	test("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
		const path = resolveGlobalConfigPath({
			env: {} as NodeJS.ProcessEnv,
			homedir: () => "/home/user",
		});

		expect(path).toBe("/home/user/.config/worktree-kit/config.jsonc");
	});

	test("falls back to ~/.config when XDG_CONFIG_HOME is empty", () => {
		const path = resolveGlobalConfigPath({
			env: { XDG_CONFIG_HOME: "" } as NodeJS.ProcessEnv,
			homedir: () => "/home/user",
		});

		expect(path).toBe("/home/user/.config/worktree-kit/config.jsonc");
	});
});
