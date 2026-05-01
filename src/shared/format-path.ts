import { homedir } from "node:os";
import { relative } from "node:path";

export function formatDisplayPath(absolutePath: string, repoRoot: string): string {
	const rel = relative(repoRoot, absolutePath);
	if (!rel.startsWith("..")) return rel;

	const home = homedir();
	if (absolutePath.startsWith(home)) {
		return `~${absolutePath.slice(home.length)}`;
	}

	return absolutePath;
}
