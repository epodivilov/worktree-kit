import type { LoadConfigOutput, PartialOverrides } from "./load-config.ts";

export type ConfigSource = "global" | "repo" | "local" | "default";

export interface ProvenanceEntry {
	value: unknown;
	source: ConfigSource;
	sourcePath: string | null;
}

export type ProvenanceMap = Record<string, ProvenanceEntry>;

export interface ResolveConfigProvenanceOutput {
	fields: ProvenanceMap;
	sources: {
		global: string | null;
		repo: string;
		local: string | null;
	};
}

const LEAF_PATHS: readonly string[] = [
	"rootDir",
	"copy",
	"symlinks",
	"hooks.post-create",
	"hooks.pre-remove",
	"hooks.post-update",
	"hooks.on-conflict",
	"defaultBase",
	"create.base",
	"remove.deleteBranch",
	"remove.deleteRemoteBranch",
];

function getByPath(source: unknown, segments: readonly string[]): { found: boolean; value: unknown } {
	let cursor: unknown = source;
	for (const segment of segments) {
		if (cursor === null || cursor === undefined || typeof cursor !== "object" || Array.isArray(cursor)) {
			return { found: false, value: undefined };
		}
		const obj = cursor as Record<string, unknown>;
		if (!Object.hasOwn(obj, segment)) {
			return { found: false, value: undefined };
		}
		cursor = obj[segment];
	}
	return { found: true, value: cursor };
}

function findSource(
	segments: readonly string[],
	local: PartialOverrides | null,
	repo: PartialOverrides,
	global: PartialOverrides | null,
): ConfigSource {
	if (local && getByPath(local, segments).found) return "local";
	if (getByPath(repo, segments).found) return "repo";
	if (global && getByPath(global, segments).found) return "global";
	return "default";
}

export function resolveConfigProvenance(input: LoadConfigOutput): ResolveConfigProvenanceOutput {
	const { config, configPath, localConfigPath, globalConfigPath, globalOverrides, repoOverrides, localOverrides } =
		input;

	const fields: ProvenanceMap = {};
	const sourcePaths: Record<ConfigSource, string | null> = {
		global: globalConfigPath,
		repo: configPath,
		local: localConfigPath,
		default: null,
	};

	for (const path of LEAF_PATHS) {
		const segments = path.split(".");
		const { value } = getByPath(config, segments);
		const source = findSource(segments, localOverrides, repoOverrides, globalOverrides);
		fields[path] = {
			value,
			source,
			sourcePath: sourcePaths[source],
		};
	}

	return {
		fields,
		sources: {
			global: globalConfigPath,
			repo: configPath,
			local: localConfigPath,
		},
	};
}
