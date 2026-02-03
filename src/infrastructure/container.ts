import type { FilesystemPort } from "../domain/ports/filesystem-port.ts";
import type { GitPort } from "../domain/ports/git-port.ts";
import type { UiPort } from "../domain/ports/ui-port.ts";
import { createBunFilesystemAdapter } from "./adapters/bun-filesystem-adapter.ts";
import { createBunGitAdapter } from "./adapters/bun-git-adapter.ts";
import { createClackUiAdapter } from "./adapters/clack-ui-adapter.ts";

export interface Container {
	readonly ui: UiPort;
	readonly git: GitPort;
	readonly fs: FilesystemPort;
}

export function createContainer(): Container {
	return {
		ui: createClackUiAdapter(),
		git: createBunGitAdapter(),
		fs: createBunFilesystemAdapter(),
	};
}
