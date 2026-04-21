import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import { isNewer } from "../../shared/semver-compare.ts";

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCheckCache {
	checkedAt: number;
	latestVersion: string;
}

export interface CheckForUpdatesDeps {
	fs: FilesystemPort;
	cachePath: string;
	currentVersion: string;
	now?: () => number;
	ttlMs?: number;
}

export interface CheckForUpdatesResult {
	hasUpdate: boolean;
	latestVersion: string | null;
	isFresh: boolean;
}

export async function checkForUpdates(deps: CheckForUpdatesDeps): Promise<CheckForUpdatesResult> {
	const { fs, cachePath, currentVersion, now = Date.now, ttlMs = UPDATE_CHECK_TTL_MS } = deps;

	const readResult = await fs.readFile(cachePath);
	if (!readResult.success) {
		return { hasUpdate: false, latestVersion: null, isFresh: false };
	}

	let cache: UpdateCheckCache;
	try {
		const parsed = JSON.parse(readResult.data) as unknown;
		if (
			!parsed ||
			typeof parsed !== "object" ||
			typeof (parsed as UpdateCheckCache).checkedAt !== "number" ||
			typeof (parsed as UpdateCheckCache).latestVersion !== "string"
		) {
			return { hasUpdate: false, latestVersion: null, isFresh: false };
		}
		cache = parsed as UpdateCheckCache;
	} catch {
		return { hasUpdate: false, latestVersion: null, isFresh: false };
	}

	const isFresh = now() - cache.checkedAt < ttlMs;
	const hasUpdate = isNewer(cache.latestVersion, currentVersion);

	return { hasUpdate, latestVersion: cache.latestVersion, isFresh };
}

export interface RefreshUpdateCacheDeps {
	fs: FilesystemPort;
	cachePath: string;
	fetchLatest: () => Promise<{ version: string }>;
	now?: () => number;
}

export async function refreshUpdateCache(deps: RefreshUpdateCacheDeps): Promise<void> {
	const { fs, cachePath, fetchLatest, now = Date.now } = deps;

	try {
		const { version } = await fetchLatest();
		const cache: UpdateCheckCache = { checkedAt: now(), latestVersion: version };
		await fs.writeFile(cachePath, JSON.stringify(cache));
	} catch {
		// Swallow network/write errors — AC#5: no output, no crash.
	}
}
