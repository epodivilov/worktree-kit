import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import { Result as R, type Result } from "../../shared/result.ts";
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

export interface WriteUpdateCacheDeps {
	fs: FilesystemPort;
	cachePath: string;
	latestVersion: string;
	now?: () => number;
}

/**
 * Persists the known latest version to the update-check cache.
 * Used after a successful self-update to invalidate the stale "update available"
 * notice, and as the storage primitive behind {@link refreshUpdateCache}.
 */
export async function writeUpdateCache(deps: WriteUpdateCacheDeps): Promise<Result<void>> {
	const { fs, cachePath, latestVersion, now = Date.now } = deps;

	const cache: UpdateCheckCache = { checkedAt: now(), latestVersion };
	const result = await fs.writeFile(cachePath, JSON.stringify(cache));
	if (R.isErr(result)) {
		return R.err(new Error(result.error.message));
	}
	return R.ok(undefined);
}

export interface RefreshUpdateCacheDeps {
	fs: FilesystemPort;
	cachePath: string;
	fetchLatest: () => Promise<Result<{ version: string }>>;
	now?: () => number;
}

export async function refreshUpdateCache(deps: RefreshUpdateCacheDeps): Promise<void> {
	const { fs, cachePath, fetchLatest, now = Date.now } = deps;

	const result = await fetchLatest();
	if (R.isErr(result)) return;

	await writeUpdateCache({ fs, cachePath, latestVersion: result.data.version, now });
}
