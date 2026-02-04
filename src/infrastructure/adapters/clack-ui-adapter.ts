import * as clack from "@clack/prompts";
import pc from "picocolors";
import type { UiPort } from "../../domain/ports/ui-port.ts";

export function createClackUiAdapter(): UiPort {
	return {
		intro(message: string): void {
			clack.intro(pc.bgCyan(pc.black(` ${message} `)));
		},

		outro(message: string): void {
			clack.outro(message);
		},

		info(message: string): void {
			clack.log.info(message);
		},

		success(message: string): void {
			clack.log.success(pc.green(message));
		},

		warn(message: string): void {
			clack.log.warn(pc.yellow(message));
		},

		error(message: string): void {
			clack.log.error(pc.red(message));
		},

		async spinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
			const s = clack.spinner();
			s.start(message);
			try {
				const result = await fn();
				s.stop(pc.green("Done"));
				return result;
			} catch (error) {
				s.stop(pc.red("Failed"));
				throw error;
			}
		},

		async text(options: { message: string; placeholder?: string; defaultValue?: string }): Promise<string | symbol> {
			return clack.text({
				message: options.message,
				placeholder: options.placeholder,
				defaultValue: options.defaultValue,
			});
		},

		async confirm(options: { message: string; initialValue?: boolean }): Promise<boolean | symbol> {
			return clack.confirm({
				message: options.message,
				initialValue: options.initialValue,
			});
		},

		async select<T>(options: {
			message: string;
			options: Array<{ value: T; label: string; hint?: string }>;
		}): Promise<T | symbol> {
			return clack.select({
				message: options.message,
				options: options.options as Parameters<typeof clack.select<T>>[0]["options"],
			});
		},

		isCancel(value: unknown): value is symbol {
			return clack.isCancel(value);
		},

		cancel(message?: string): void {
			clack.cancel(message ?? "Operation cancelled.");
		},
	};
}
