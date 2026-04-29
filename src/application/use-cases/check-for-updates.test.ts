import { describe, expect, test } from "bun:test";
import { Result } from "../../shared/result.ts";
import { createFakeFilesystem } from "../../test-utils/fake-filesystem.ts";
import {
	checkForUpdates,
	refreshUpdateCache,
	UPDATE_CHECK_TTL_MS,
	type UpdateCheckCache,
} from "./check-for-updates.ts";

const CACHE_PATH = "/fake/cache/wt/update-check.json";
const NOW = 1_700_000_000_000;

function cacheJson(cache: UpdateCheckCache): string {
	return JSON.stringify(cache);
}

describe("checkForUpdates", () => {
	test("returns hasUpdate=true when fresh cache holds a newer version", async () => {
		const fs = createFakeFilesystem({
			files: { [CACHE_PATH]: cacheJson({ checkedAt: NOW - 1000, latestVersion: "1.0.0" }) },
		});

		const result = await checkForUpdates({
			fs,
			cachePath: CACHE_PATH,
			currentVersion: "0.9.0",
			now: () => NOW,
		});

		expect(result).toEqual({ hasUpdate: true, latestVersion: "1.0.0", isFresh: true });
	});

	test("returns hasUpdate=false when cached version matches current", async () => {
		const fs = createFakeFilesystem({
			files: { [CACHE_PATH]: cacheJson({ checkedAt: NOW - 1000, latestVersion: "1.0.0" }) },
		});

		const result = await checkForUpdates({
			fs,
			cachePath: CACHE_PATH,
			currentVersion: "1.0.0",
			now: () => NOW,
		});

		expect(result).toEqual({ hasUpdate: false, latestVersion: "1.0.0", isFresh: true });
	});

	test("returns isFresh=false when cache is older than TTL", async () => {
		const fs = createFakeFilesystem({
			files: {
				[CACHE_PATH]: cacheJson({ checkedAt: NOW - UPDATE_CHECK_TTL_MS - 1, latestVersion: "1.0.0" }),
			},
		});

		const result = await checkForUpdates({
			fs,
			cachePath: CACHE_PATH,
			currentVersion: "0.9.0",
			now: () => NOW,
		});

		expect(result.isFresh).toBe(false);
		expect(result.hasUpdate).toBe(true);
	});

	test("returns empty result when cache file is missing", async () => {
		const fs = createFakeFilesystem({});

		const result = await checkForUpdates({
			fs,
			cachePath: CACHE_PATH,
			currentVersion: "0.9.0",
			now: () => NOW,
		});

		expect(result).toEqual({ hasUpdate: false, latestVersion: null, isFresh: false });
	});

	test("returns empty result when cache JSON is malformed", async () => {
		const fs = createFakeFilesystem({ files: { [CACHE_PATH]: "{not json" } });

		const result = await checkForUpdates({
			fs,
			cachePath: CACHE_PATH,
			currentVersion: "0.9.0",
			now: () => NOW,
		});

		expect(result).toEqual({ hasUpdate: false, latestVersion: null, isFresh: false });
	});

	test("returns empty result when cache has wrong shape", async () => {
		const fs = createFakeFilesystem({ files: { [CACHE_PATH]: JSON.stringify({ foo: "bar" }) } });

		const result = await checkForUpdates({
			fs,
			cachePath: CACHE_PATH,
			currentVersion: "0.9.0",
			now: () => NOW,
		});

		expect(result).toEqual({ hasUpdate: false, latestVersion: null, isFresh: false });
	});
});

describe("refreshUpdateCache", () => {
	test("writes fetched version and checkedAt to cache", async () => {
		const fs = createFakeFilesystem({});

		await refreshUpdateCache({
			fs,
			cachePath: CACHE_PATH,
			fetchLatest: async () => Result.ok({ version: "2.0.0" }),
			now: () => NOW,
		});

		const written = await fs.readFile(CACHE_PATH);
		expect(written.success).toBe(true);
		if (!written.success) return;
		expect(JSON.parse(written.data)).toEqual({ checkedAt: NOW, latestVersion: "2.0.0" });
	});

	test("swallows fetch errors without throwing", async () => {
		const fs = createFakeFilesystem({});

		await refreshUpdateCache({
			fs,
			cachePath: CACHE_PATH,
			fetchLatest: async () => Result.err(new Error("network down")),
			now: () => NOW,
		});

		expect(await fs.exists(CACHE_PATH)).toBe(false);
	});
});
