import pc from "picocolors";
import type { LogCategory, LoggerPort } from "../../domain/ports/logger-port.ts";

export function createConsoleLoggerAdapter(verbose: boolean): LoggerPort {
	return {
		debug(category: LogCategory, message: string): void {
			if (!verbose) return;
			console.error(pc.dim(`[${category}] ${message}`));
		},

		isVerbose(): boolean {
			return verbose;
		},
	};
}
