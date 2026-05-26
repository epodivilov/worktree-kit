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

/**
 * Resolved upstream decision computed by the CLI layer (which handles all
 * detection and prompting). When present, `name` is the remote name to record
 * in config; `remote`, if set, describes a git mutation to perform first.
 */
export interface UpstreamDecision {
	/** Name of the git remote to record in config (e.g. "upstream", "source"). */
	name: string;
	/** Optional remote mutation to perform before writing the config. */
	remote?: {
		action: "add" | "set-url";
		url: string;
	};
}

export interface InitConfigInput {
	force?: boolean;
	migrate?: boolean;
	local?: boolean;
	/** Resolved upstream decision from the CLI layer. */
	upstream?: UpstreamDecision;
}

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

	if (input.upstream?.remote) {
		const { action, url } = input.upstream.remote;
		if (action === "add") {
			const addResult = await git.addRemote(input.upstream.name, url);
			if (!addResult.success) {
				return R.err(new Error(`Failed to add upstream remote: ${addResult.error.message}`));
			}
		} else {
			const setResult = await git.setRemoteUrl(input.upstream.name, url);
			if (!setResult.success) {
				return R.err(new Error(`Failed to update upstream remote URL: ${setResult.error.message}`));
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
			...(input.upstream ? { upstream: input.upstream.name } : {}),
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
