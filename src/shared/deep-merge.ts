/**
 * Deep merges `override` into `base`.
 * - Objects are merged recursively.
 * - Arrays are replaced entirely (override wins).
 * - Primitives are replaced by override.
 * - `undefined` values in override are skipped.
 */
export function deepMerge<T extends object>(base: T, override: Partial<{ [K in keyof T]: unknown }>): T {
	const result = { ...base };

	for (const key of Object.keys(override) as Array<keyof T>) {
		const overrideVal = override[key];
		if (overrideVal === undefined) {
			continue;
		}

		const baseVal = base[key];

		if (
			Array.isArray(overrideVal) ||
			overrideVal === null ||
			typeof overrideVal !== "object" ||
			Array.isArray(baseVal) ||
			baseVal === null ||
			typeof baseVal !== "object"
		) {
			(result as Record<string, unknown>)[key as string] = overrideVal;
		} else {
			(result as Record<string, unknown>)[key as string] = deepMerge(
				baseVal as Record<string, unknown>,
				overrideVal as Record<string, unknown>,
			);
		}
	}

	return result;
}
