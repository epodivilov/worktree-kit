import { join } from "node:path";
import * as v from "valibot";
import { CONFIG_FILENAME } from "../../domain/constants.ts";
import type { WorktreeConfig } from "../../domain/entities/config.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import { WorktreeConfigSchema } from "../../domain/schemas/config-schema.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";

export interface LoadConfigOutput {
	config: WorktreeConfig;
	configPath: string;
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

	if (!(await fs.exists(configPath))) {
		return R.err(new Error(`Config not found at ${configPath}. Run 'wt init' to create one.`));
	}

	const readResult = await fs.readFile(configPath);
	if (!readResult.success) {
		return R.err(new Error(`Failed to read config: ${readResult.error.message}`));
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readResult.data);
	} catch {
		return R.err(new Error(`Invalid JSON in ${configPath}`));
	}

	const parseResult = v.safeParse(WorktreeConfigSchema, raw);
	if (!parseResult.success) {
		const issues = v.flatten(parseResult.issues);
		return R.err(new Error(`Invalid config in ${configPath}: ${JSON.stringify(issues)}`));
	}

	return R.ok({ config: parseResult.output, configPath });
}
