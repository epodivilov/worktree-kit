import type { LoggerPort } from "../domain/ports/logger-port.ts";

export function createNoopLogger(): LoggerPort {
	return {
		debug(): void {},
		isVerbose(): boolean {
			return false;
		},
	};
}
