import { join } from "node:path";
import {
	CONFIG_FILENAME,
	INIT_ROOT_DIR,
	LEGACY_CONFIG_FILENAME,
	LOCAL_CONFIG_FILENAME,
	SCHEMA_URL,
} from "../../domain/constants.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";

export interface InitConfigInput {
	force?: boolean;
	migrate?: boolean;
	local?: boolean;
	/** Git URL of an upstream remote to configure for fork workflows. */
	upstream?: string;
}

const UPSTREAM_REMOTE_NAME = "upstream";

export interface InitConfigOutput {
	configPath: string;
}

export interface InitConfigDeps {
	fs: FilesystemPort;
	git: GitPort;
}

export async function initConfig(
	input: InitConfigInput,
	deps: InitConfigDeps,
): Promise<Result<InitConfigOutput, Error>> {
	const { fs, git } = deps;

	const rootResult = await git.getMainWorktreeRoot();
	if (!rootResult.success) {
		return R.err(new Error(`Not a git repository: ${rootResult.error.message}`));
	}

	const configPath = join(rootResult.data, CONFIG_FILENAME);
	const legacyConfigPath = join(rootResult.data, LEGACY_CONFIG_FILENAME);

	if (input.migrate) {
		if (!(await fs.exists(legacyConfigPath))) {
			return R.err(new Error(`Legacy config not found at ${legacyConfigPath}`));
		}

		if (await fs.exists(configPath)) {
			return R.err(new Error(`New config already exists at ${configPath}`));
		}

		const renameResult = await fs.rename(legacyConfigPath, configPath);
		if (!renameResult.success) {
			return R.err(new Error(`Failed to rename config: ${renameResult.error.message}`));
		}

		const readResult = await fs.readFile(configPath);
		if (readResult.success && !readResult.data.includes('"$schema"')) {
			const schemaLine = `\t"$schema": "${SCHEMA_URL}",`;
			const updated = readResult.data.replace(/\{/, `{\n${schemaLine}`);
			await fs.writeFile(configPath, updated);
		}

		return R.ok({ configPath });
	}

	const targetPath = input.local ? join(rootResult.data, LOCAL_CONFIG_FILENAME) : configPath;

	if (!input.force && (await fs.exists(targetPath))) {
		return R.err(new Error(`Config already exists at ${targetPath}`));
	}

	if (input.upstream) {
		const remotesResult = await git.listRemotes();
		if (!remotesResult.success) {
			return R.err(new Error(`Failed to list remotes: ${remotesResult.error.message}`));
		}
		if (!remotesResult.data.includes(UPSTREAM_REMOTE_NAME)) {
			const addResult = await git.addRemote(UPSTREAM_REMOTE_NAME, input.upstream);
			if (!addResult.success) {
				return R.err(new Error(`Failed to add upstream remote: ${addResult.error.message}`));
			}
		}
	}

	const content = JSON.stringify(
		{
			$schema: SCHEMA_URL,
			rootDir: INIT_ROOT_DIR,
			copy: [],
			symlinks: [],
			defaultBase: "ask",
			...(input.upstream ? { upstream: UPSTREAM_REMOTE_NAME } : {}),
		},
		null,
		2,
	);
	const writeResult = await fs.writeFile(targetPath, content);
	if (!writeResult.success) {
		return R.err(new Error(`Failed to write config: ${writeResult.error.message}`));
	}

	return R.ok({ configPath: targetPath });
}
