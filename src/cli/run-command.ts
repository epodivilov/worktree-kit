import type { UiPort } from "../domain/ports/ui-port.ts";

export class CommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommandError";
	}
}

export async function runCommand(handler: () => Promise<void>, ui: UiPort): Promise<void> {
	try {
		await handler();
	} catch (err) {
		if (err instanceof CommandError) {
			ui.error(err.message);
		} else {
			ui.error(err instanceof Error ? `Unexpected error: ${err.message}` : "Unexpected error");
		}
		process.exit(1);
	}
}
