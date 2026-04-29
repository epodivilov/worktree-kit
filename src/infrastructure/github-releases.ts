import { Result as R, type Result } from "../shared/result.ts";

const REPO = "epodivilov/worktree-kit";

export interface LatestRelease {
	tag: string;
	version: string;
}

export async function fetchLatestVersion(): Promise<Result<LatestRelease>> {
	let res: Response;
	try {
		res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
			headers: { Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(15_000),
		});
	} catch (err) {
		if (err instanceof Error && err.name === "TimeoutError") {
			return R.err(new Error("GitHub API timeout"));
		}
		return R.err(err instanceof Error ? err : new Error(String(err)));
	}

	if (!res.ok) {
		return R.err(new Error(`GitHub API error: ${res.status} ${res.statusText}`));
	}

	let data: { tag_name: string };
	try {
		data = (await res.json()) as { tag_name: string };
	} catch {
		return R.err(new Error("Failed to parse GitHub API response"));
	}
	const tag = data.tag_name;
	const version = tag.startsWith("v") ? tag.slice(1) : tag;

	return R.ok({ tag, version });
}
