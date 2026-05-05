import { describe, expect, test } from "bun:test";
import type { WorktreeConfig } from "../../domain/entities/config.ts";
import type { LoadConfigOutput, PartialOverrides } from "./load-config.ts";
import { resolveConfigProvenance } from "./resolve-config-provenance.ts";

const REPO_PATH = "/repo/.worktreekit.jsonc";
const LOCAL_PATH = "/repo/.worktreekit.local.jsonc";
const GLOBAL_PATH = "/home/user/.config/worktree-kit/config.jsonc";

function makeConfig(overrides: Partial<WorktreeConfig> = {}): WorktreeConfig {
	return {
		rootDir: "../wt",
		copy: [],
		symlinks: [],
		hooks: {
			"post-create": [],
			"pre-remove": [],
			"post-update": [],
			"on-conflict": [],
			"post-sync": [],
		},
		defaultBase: "ask",
		create: {},
		remove: {},
		...overrides,
	};
}

function makeInput(args: {
	config: WorktreeConfig;
	repoOverrides: PartialOverrides;
	globalOverrides?: PartialOverrides | null;
	localOverrides?: PartialOverrides | null;
}): LoadConfigOutput {
	return {
		config: args.config,
		configPath: REPO_PATH,
		localConfigPath: args.localOverrides ? LOCAL_PATH : null,
		globalConfigPath: args.globalOverrides ? GLOBAL_PATH : null,
		isLegacyConfig: false,
		globalOverrides: args.globalOverrides ?? null,
		repoOverrides: args.repoOverrides,
		localOverrides: args.localOverrides ?? null,
	};
}

describe("resolveConfigProvenance", () => {
	test("attributes a field set only in repo to repo", () => {
		const result = resolveConfigProvenance(
			makeInput({
				config: makeConfig({ rootDir: "../wt", copy: [".env"] }),
				repoOverrides: { rootDir: "../wt", copy: [".env"] },
			}),
		);

		expect(result.fields.rootDir).toEqual({ value: "../wt", source: "repo", sourcePath: REPO_PATH });
		expect(result.fields.copy).toEqual({ value: [".env"], source: "repo", sourcePath: REPO_PATH });
	});

	test("attributes a field set only in global to global", () => {
		const result = resolveConfigProvenance(
			makeInput({
				config: makeConfig({ rootDir: "../wt", defaultBase: "default" }),
				repoOverrides: { rootDir: "../wt" },
				globalOverrides: { defaultBase: "default" },
			}),
		);

		expect(result.fields.defaultBase).toEqual({
			value: "default",
			source: "global",
			sourcePath: GLOBAL_PATH,
		});
	});

	test("repo override beats global", () => {
		const result = resolveConfigProvenance(
			makeInput({
				config: makeConfig({ defaultBase: "current" }),
				repoOverrides: { rootDir: "../wt", defaultBase: "current" },
				globalOverrides: { defaultBase: "default" },
			}),
		);

		expect(result.fields.defaultBase).toEqual({
			value: "current",
			source: "repo",
			sourcePath: REPO_PATH,
		});
	});

	test("local override beats repo and global", () => {
		const result = resolveConfigProvenance(
			makeInput({
				config: makeConfig({ defaultBase: "current" }),
				repoOverrides: { rootDir: "../wt", defaultBase: "default" },
				globalOverrides: { defaultBase: "default" },
				localOverrides: { defaultBase: "current" },
			}),
		);

		expect(result.fields.defaultBase).toEqual({
			value: "current",
			source: "local",
			sourcePath: LOCAL_PATH,
		});
	});

	test("untouched fields fall through to default", () => {
		const result = resolveConfigProvenance(
			makeInput({
				config: makeConfig({ rootDir: "../wt" }),
				repoOverrides: { rootDir: "../wt" },
			}),
		);

		expect(result.fields.symlinks).toEqual({ value: [], source: "default", sourcePath: null });
		expect(result.fields.defaultBase).toEqual({ value: "ask", source: "default", sourcePath: null });
		expect(result.fields["create.base"]).toEqual({ value: undefined, source: "default", sourcePath: null });
	});

	test("nested hook fields resolve independently", () => {
		const result = resolveConfigProvenance(
			makeInput({
				config: makeConfig({
					hooks: {
						"post-create": ["echo global"],
						"pre-remove": ["echo local"],
						"post-update": ["echo repo"],
						"on-conflict": [],
						"post-sync": [],
					},
				}),
				repoOverrides: { rootDir: "../wt", hooks: { "post-update": ["echo repo"] } },
				globalOverrides: { hooks: { "post-create": ["echo global"] } },
				localOverrides: { hooks: { "pre-remove": ["echo local"] } },
			}),
		);

		expect(result.fields["hooks.post-create"]?.source).toBe("global");
		expect(result.fields["hooks.pre-remove"]?.source).toBe("local");
		expect(result.fields["hooks.post-update"]?.source).toBe("repo");
		expect(result.fields["hooks.on-conflict"]?.source).toBe("default");
	});

	test("source paths reflect input paths", () => {
		const result = resolveConfigProvenance(
			makeInput({
				config: makeConfig(),
				repoOverrides: { rootDir: "../wt" },
				globalOverrides: { defaultBase: "default" },
				localOverrides: { defaultBase: "current" },
			}),
		);

		expect(result.sources).toEqual({
			global: GLOBAL_PATH,
			repo: REPO_PATH,
			local: LOCAL_PATH,
		});
	});
});
