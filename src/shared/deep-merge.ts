/**
 * Deep merges `override` into `base`.
 * - Objects are merged recursively.
 * - Arrays are replaced entirely (override wins).
 * - Primitives are replaced by override.
 * - `undefined` values in override are skipped.
 */

type AnyObject = Record<string, unknown>;

export type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export function deepMerge<T extends object>(base: T, override: DeepPartial<T>): T {
	const result = { ...base };

	// Safety: base is T extends object, override is Partial<T>, result is a spread of T.
	// We cast once here to avoid repeated inline casts in the loop below.
	// The return type is still T, guaranteed by the spread + selective overwrites.
	const baseObj = base as AnyObject;
	const overrideObj = override as AnyObject;
	const resultObj = result as AnyObject;

	for (const key of Object.keys(overrideObj)) {
		const overrideVal = overrideObj[key];
		if (overrideVal === undefined) {
			continue;
		}

		const baseVal = baseObj[key];

		if (
			Array.isArray(overrideVal) ||
			overrideVal === null ||
			typeof overrideVal !== "object" ||
			Array.isArray(baseVal) ||
			baseVal === null ||
			typeof baseVal !== "object"
		) {
			resultObj[key] = overrideVal;
		} else {
			resultObj[key] = deepMerge(baseVal as AnyObject, overrideVal as AnyObject);
		}
	}

	return result;
}
