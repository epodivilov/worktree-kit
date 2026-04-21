const REPO = "epodivilov/worktree-kit";

export interface LatestRelease {
	tag: string;
	version: string;
}

export async function fetchLatestVersion(): Promise<LatestRelease> {
	let res: Response;
	try {
		res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
			headers: { Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(15_000),
		});
	} catch (err) {
		if (err instanceof Error && err.name === "TimeoutError") {
			throw new Error("GitHub API timeout");
		}
		throw err;
	}

	if (!res.ok) {
		throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
	}

	const data = (await res.json()) as { tag_name: string };
	const tag = data.tag_name;
	const version = tag.startsWith("v") ? tag.slice(1) : tag;

	return { tag, version };
}
