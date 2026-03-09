import { join } from "node:path";
import stripJsonComments from "strip-json-comments";
import * as v from "valibot";
import { CONFIG_FILENAME, LEGACY_CONFIG_FILENAME, LOCAL_CONFIG_FILENAME } from "../../domain/constants.ts";
import type { WorktreeConfig } from "../../domain/entities/config.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import { PartialWorktreeConfigSchema, WorktreeConfigSchema } from "../../domain/schemas/config-schema.ts";
import { deepMerge } from "../../shared/deep-merge.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";
import { stripTrailingCommas } from "../../shared/strip-trailing-commas.ts";

export interface LoadConfigOutput {
	config: WorktreeConfig;
	configPath: string;
	localConfigPath: string | null;
	isLegacyConfig: boolean;
}

export interface LoadConfigDeps {
	fs: FilesystemPort;
	git: GitPort;
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

	const parseResult = v.safeParse(WorktreeConfigSchema, raw);
	if (!parseResult.success) {
		const issues = v.flatten(parseResult.issues);
		return R.err(new Error(`Invalid config in ${actualPath}: ${JSON.stringify(issues)}`));
	}

	let config: WorktreeConfig = parseResult.output;
	let localConfigPath: string | null = null;

	const localPath = join(rootResult.data, LOCAL_CONFIG_FILENAME);
	if (await fs.exists(localPath)) {
		const localReadResult = await fs.readFile(localPath);
		if (!localReadResult.success) {
			return R.err(new Error(`Failed to read local config: ${localReadResult.error.message}`));
		}

		let localRaw: unknown;
		try {
			localRaw = JSON.parse(stripTrailingCommas(stripJsonComments(localReadResult.data)));
		} catch {
			return R.err(new Error(`Invalid JSONC in ${localPath}`));
		}

		const localParseResult = v.safeParse(PartialWorktreeConfigSchema, localRaw);
		if (!localParseResult.success) {
			const issues = v.flatten(localParseResult.issues);
			return R.err(new Error(`Invalid local config in ${localPath}: ${JSON.stringify(issues)}`));
		}

		const { $schema: _, ...overrides } = localParseResult.output;
		config = deepMerge(config, overrides);
		localConfigPath = localPath;
	}

	return R.ok({ config, configPath: actualPath, localConfigPath, isLegacyConfig });
}
