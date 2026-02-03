export type Result<T, E = Error> = { success: true; data: T } | { success: false; error: E };

export const Result = {
	ok<T>(data: T): Result<T, never> {
		return { success: true, data };
	},

	err<E>(error: E): Result<never, E> {
		return { success: false, error };
	},

	isOk<T, E>(result: Result<T, E>): result is { success: true; data: T } {
		return result.success;
	},

	isErr<T, E>(result: Result<T, E>): result is { success: false; error: E } {
		return !result.success;
	},
} as const;
