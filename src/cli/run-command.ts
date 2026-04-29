import type { UiPort } from "../domain/ports/ui-port.ts";
import { EXIT_FAILURE, EXIT_USAGE } from "./exit-codes.ts";

export class CommandError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode: number = EXIT_USAGE) {
		super(message);
		this.name = "CommandError";
		this.exitCode = exitCode;
	}
}

export async function runCommand(handler: () => Promise<void>, ui: UiPort): Promise<void> {
	try {
		await handler();
	} catch (err) {
		if (err instanceof CommandError) {
			ui.error(err.message);
			process.exit(err.exitCode);
		} else {
			ui.error(err instanceof Error ? `Unexpected error: ${err.message}` : "Unexpected error");
			process.exit(EXIT_FAILURE);
		}
	}
}
