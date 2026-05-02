import { join } from "node:path";
import stripJsonComments from "strip-json-comments";
import * as v from "valibot";
import { CONFIG_FILENAME, LEGACY_CONFIG_FILENAME, LOCAL_CONFIG_FILENAME } from "../../domain/constants.ts";
import type { WorktreeConfig } from "../../domain/entities/config.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import {
	type PartialWorktreeConfigInput,
	PartialWorktreeConfigSchema,
	WorktreeConfigSchema,
} from "../../domain/schemas/config-schema.ts";
import { deepMerge } from "../../shared/deep-merge.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";
import { stripTrailingCommas } from "../../shared/strip-trailing-commas.ts";
import { resolveGlobalConfigPath } from "../../shared/xdg-paths.ts";

export interface LoadConfigOutput {
	config: WorktreeConfig;
	configPath: string;
	localConfigPath: string | null;
	globalConfigPath: string | null;
	isLegacyConfig: boolean;
}

export interface LoadConfigDeps {
	fs: FilesystemPort;
	git: GitPort;
	globalConfigPath?: string;
}

type PartialOverrides = Omit<PartialWorktreeConfigInput, "$schema">;

function parsePartialConfig(content: string, path: string, label: string): Result<PartialOverrides, Error> {
	let raw: unknown;
	try {
		raw = JSON.parse(stripTrailingCommas(stripJsonComments(content)));
	} catch {
		return R.err(new Error(`Invalid JSONC in ${path}`));
	}

	const parsed = v.safeParse(PartialWorktreeConfigSchema, raw);
	if (!parsed.success) {
		const issues = v.flatten(parsed.issues);
		return R.err(new Error(`Invalid ${label} config in ${path}: ${JSON.stringify(issues)}`));
	}

	const { $schema: _, ...overrides } = parsed.output;
	return R.ok(overrides);
}

async function readPartialConfig(
	fs: FilesystemPort,
	path: string,
	label: string,
): Promise<Result<PartialOverrides, Error>> {
	const readResult = await fs.readFile(path);
	if (!readResult.success) {
		return R.err(new Error(`Failed to read ${label} config: ${readResult.error.message}`));
	}
	return parsePartialConfig(readResult.data, path, label);
}

export async function loadConfig(deps: LoadConfigDeps): Promise<Result<LoadConfigOutput, Error>> {
	const { fs, git } = deps;

	const rootResult = await git.getMainWorktreeRoot();
	if (!rootResult.success) {
		return R.err(new Error(`Not a git repository: ${rootResult.error.message}`));
	}

	const configPath = join(rootResult.data, CONFIG_FILENAME);
	const legacyConfigPath = join(rootResult.data, LEGACY_CONFIG_FILENAME);

	let actualPath: string;
	let isLegacyConfig: boolean;

	if (await fs.exists(configPath)) {
		actualPath = configPath;
		isLegacyConfig = false;
	} else if (await fs.exists(legacyConfigPath)) {
		actualPath = legacyConfigPath;
		isLegacyConfig = true;
	} else {
		return R.err(new Error(`Config not found at ${configPath}. Run 'wt init' to create one.`));
	}

	const globalPath = deps.globalConfigPath ?? resolveGlobalConfigPath();
	let globalOverrides: PartialOverrides | null = null;
	let globalConfigPath: string | null = null;
	const globalReadResult = await fs.readFile(globalPath);
	if (globalReadResult.success) {
		const globalResult = parsePartialConfig(globalReadResult.data, globalPath, "global");
		if (!globalResult.success) {
			return R.err(globalResult.error);
		}
		globalOverrides = globalResult.data;
		globalConfigPath = globalPath;
	} else if (globalReadResult.error.code !== "NOT_FOUND") {
		return R.err(new Error(`Failed to read global config: ${globalReadResult.error.message}`));
	}

	const readResult = await fs.readFile(actualPath);
	if (!readResult.success) {
		return R.err(new Error(`Failed to read config: ${readResult.error.message}`));
	}

	let raw: unknown;
	try {
		raw = JSON.parse(stripTrailingCommas(stripJsonComments(readResult.data)));
	} catch {
		return R.err(new Error(`Invalid JSONC in ${actualPath}`));
	}

	let mergedRaw: unknown = raw;
	if (globalOverrides && raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
		mergedRaw = deepMerge(globalOverrides as Record<string, unknown>, raw as Record<string, unknown>);
	}

	const parseResult = v.safeParse(WorktreeConfigSchema, mergedRaw);
	if (!parseResult.success) {
		const issues = v.flatten(parseResult.issues);
		return R.err(new Error(`Invalid config in ${actualPath}: ${JSON.stringify(issues)}`));
	}

	let config: WorktreeConfig = parseResult.output;
	let localConfigPath: string | null = null;

	const localPath = join(rootResult.data, LOCAL_CONFIG_FILENAME);
	if (await fs.exists(localPath)) {
		const localResult = await readPartialConfig(fs, localPath, "local");
		if (!localResult.success) {
			return R.err(localResult.error);
		}
		config = deepMerge(config, localResult.data);
		localConfigPath = localPath;
	}

	return R.ok({ config, configPath: actualPath, localConfigPath, globalConfigPath, isLegacyConfig });
}
