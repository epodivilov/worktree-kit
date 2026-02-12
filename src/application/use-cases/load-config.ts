import { join } from "node:path";
import stripJsonComments from "strip-json-comments";
import * as v from "valibot";
import { CONFIG_FILENAME, LEGACY_CONFIG_FILENAME } from "../../domain/constants.ts";
import type { WorktreeConfig } from "../../domain/entities/config.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import { WorktreeConfigSchema } from "../../domain/schemas/config-schema.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";

export interface LoadConfigOutput {
	config: WorktreeConfig;
	configPath: string;
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
		raw = JSON.parse(stripJsonComments(readResult.data));
	} catch {
		return R.err(new Error(`Invalid JSONC in ${actualPath}`));
	}

	const parseResult = v.safeParse(WorktreeConfigSchema, raw);
	if (!parseResult.success) {
		const issues = v.flatten(parseResult.issues);
		return R.err(new Error(`Invalid config in ${actualPath}: ${JSON.stringify(issues)}`));
	}

	return R.ok({ config: parseResult.output, configPath: actualPath, isLegacyConfig });
}
