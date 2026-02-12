/**
 * Remove trailing commas from JSON strings (commas before `]` or `}`).
 * Intended to be used after `strip-json-comments` so there are no
 * comment tokens left that could confuse the regex.
 */
export function stripTrailingCommas(input: string): string {
	return input.replace(/,(\s*[\]}])/g, "$1");
}
