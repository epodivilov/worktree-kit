import { homedir } from "node:os";
import { join } from "node:path";
import { GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILENAME } from "../domain/constants.ts";

export function getCacheDir(): string {
	const xdg = process.env.XDG_CACHE_HOME;
	const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".cache");
	return join(base, "wt");
}

export interface ResolveGlobalConfigPathOptions {
	env?: NodeJS.ProcessEnv;
	homedir?: () => string;
}

export function resolveGlobalConfigPath(options: ResolveGlobalConfigPathOptions = {}): string {
	const env = options.env ?? process.env;
	const home = (options.homedir ?? homedir)();
	const xdg = env.XDG_CONFIG_HOME;
	const base = xdg && xdg.length > 0 ? xdg : join(home, ".config");
	return join(base, GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILENAME);
}
