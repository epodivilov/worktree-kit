/**
 * Deduplicate an array by a key function, keeping the first occurrence.
 */
export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const k = key(item);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}
