import type { ArgsDef } from "citty";

/**
 * Global flags declared on the root command that drive runtime behavior: the
 * root `setup()` parses the entire argv and builds the container from them, so
 * `--non-interactive`/`--verbose` already take effect in any position.
 *
 * citty renders each subcommand's `--help` from that subcommand's own `args`
 * alone — it never merges parent/global args (see `renderUsage` in citty). So
 * these definitions are also spread into every subcommand purely for help
 * visibility: an agent inspecting `wt <cmd> --help` sees the flags exist.
 *
 * A subcommand's `run` must NOT read these keys — doing so would reintroduce
 * position-dependent parsing. They are declared for rendering only.
 */
export const GLOBAL_ARGS = {
	verbose: {
		type: "boolean",
		default: false,
		description: "Enable verbose logging",
	},
	"non-interactive": {
		type: "boolean",
		default: false,
		description: "Disable interactive prompts",
	},
} as const satisfies ArgsDef;
