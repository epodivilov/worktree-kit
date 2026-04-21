import { homedir } from "node:os";
import { join } from "node:path";

export function getCacheDir(): string {
	const xdg = process.env.XDG_CACHE_HOME;
	const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".cache");
	return join(base, "wt");
}
