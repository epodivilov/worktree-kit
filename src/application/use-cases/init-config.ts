import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
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
}

export async function initConfig(
	_input: InitConfigInput,
	_deps: InitConfigDeps,
): Promise<Result<InitConfigOutput, Error>> {
	return R.err(new Error("Not implemented"));
}
