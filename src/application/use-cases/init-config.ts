import { join } from "node:path";
import { CONFIG_FILENAME, INIT_ROOT_DIR } from "../../domain/constants.ts";
import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { GitPort } from "../../domain/ports/git-port.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";

export interface InitConfigInput {
	force?: boolean;
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

	if (!input.force && (await fs.exists(configPath))) {
		return R.err(new Error(`Config already exists at ${configPath}`));
	}

	const content = JSON.stringify({ rootDir: INIT_ROOT_DIR, copy: [], defaultBase: "ask" }, null, 2);
	const writeResult = await fs.writeFile(configPath, content);
	if (!writeResult.success) {
		return R.err(new Error(`Failed to write config: ${writeResult.error.message}`));
	}

	return R.ok({ configPath });
}
