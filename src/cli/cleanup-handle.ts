import { EXIT_CANCEL } from "./exit-codes.ts";

export class CleanupHandle {
	private handler: (() => Promise<void>) | null = null;
	private sigintListener: (() => void) | null = null;

	register(cleanup: () => Promise<void>): void {
		this.handler = cleanup;
		if (!this.sigintListener) {
			this.sigintListener = () => {
				const h = this.handler;
				this.handler = null;
				if (h) {
					h().finally(() => process.exit(EXIT_CANCEL));
				} else {
					process.exit(EXIT_CANCEL);
				}
			};
			process.on("SIGINT", this.sigintListener);
		}
	}

	clear(): void {
		this.handler = null;
		if (this.sigintListener) {
			process.removeListener("SIGINT", this.sigintListener);
			this.sigintListener = null;
		}
	}
}
