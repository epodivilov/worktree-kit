export interface ResolveNonInteractiveInput {
	/** Explicit `--non-interactive` flag. */
	readonly flag: boolean;
	/** Raw value of `WT_NON_INTERACTIVE` (`"1"` enables). */
	readonly env: string | undefined;
	/** `process.stdin.isTTY`: `true` or `undefined`. */
	readonly stdinIsTTY: boolean | undefined;
	/** `process.stdout.isTTY`: `true` or `undefined`. */
	readonly stdoutIsTTY: boolean | undefined;
}

/**
 * Decide whether wt runs without interactive prompts.
 *
 * The explicit `--non-interactive` flag and `WT_NON_INTERACTIVE=1` force it on.
 * A non-TTY stdin or stdout (AI-agent shell, CI, piped I/O) also forces it on,
 * so no prompt can block forever on input that can never arrive. Interactive is
 * only possible when nothing forces it off and both stdin and stdout are real
 * terminals.
 *
 * `isTTY` is `true` or `undefined` (never `false`) in Node/Bun, so any falsy
 * value means "not a TTY" — hence the truthiness checks rather than `=== false`.
 */
export function resolveNonInteractive({ flag, env, stdinIsTTY, stdoutIsTTY }: ResolveNonInteractiveInput): boolean {
	if (flag) return true;
	if (env === "1") return true;
	if (!stdinIsTTY) return true;
	if (!stdoutIsTTY) return true;
	return false;
}
