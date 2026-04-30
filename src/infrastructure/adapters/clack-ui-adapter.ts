import * as clack from "@clack/prompts";
import pc from "picocolors";
import type { MultiSpinnerHandle, SpinnerHandle, UiPort } from "../../domain/ports/ui-port.ts";

export function createClackUiAdapter(options?: { nonInteractive?: boolean }): UiPort {
	return {
		nonInteractive: options?.nonInteractive ?? false,

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

		createSpinner(): SpinnerHandle {
			const s = clack.spinner();
			return {
				start: (message: string) => s.start(message),
				message: (message: string) => s.message(message),
				stop: (message?: string) => s.stop(message ?? pc.green("Done")),
			};
		},

		createMultiSpinner(keys: string[]): MultiSpinnerHandle {
			if (!process.stdout.isTTY) {
				return {
					update(_key: string, _message: string) {},
					complete(key: string, message: string) {
						process.stdout.write(`  ✓  ${key}: ${message}\n`);
					},
					fail(key: string, message: string) {
						process.stdout.write(`  ✗  ${key}: ${message}\n`);
					},
					stop() {},
				};
			}

			const frames = ["◒", "◐", "◓", "◑"];
			let frameIndex = 0;
			let rendered = false;

			const lines = new Map<string, { status: "active" | "done" | "error"; message: string }>();
			for (const key of keys) {
				lines.set(key, { status: "active", message: "waiting" });
			}

			function render() {
				if (rendered) {
					process.stdout.write(`\x1b[${lines.size}A`);
				} else {
					process.stdout.write("\x1b[?25l");
				}
				rendered = true;

				const frame = frames[frameIndex % frames.length];
				for (const [key, line] of lines) {
					let prefix: string;
					let msg: string;
					if (line.status === "done") {
						prefix = pc.green("✓");
						msg = pc.green(line.message);
					} else if (line.status === "error") {
						prefix = pc.red("✗");
						msg = pc.red(line.message);
					} else {
						prefix = pc.magenta(frame);
						msg = line.message;
					}
					process.stdout.write(`\x1b[2K  ${prefix}  ${key}: ${msg}\n`);
				}
			}

			const interval = setInterval(() => {
				frameIndex++;
				const hasActive = [...lines.values()].some((l) => l.status === "active");
				if (hasActive) render();
			}, 80);

			render();

			return {
				update(key: string, message: string) {
					const line = lines.get(key);
					if (line && line.status === "active") {
						line.message = message;
					}
				},
				complete(key: string, message: string) {
					const line = lines.get(key);
					if (line) {
						line.status = "done";
						line.message = message;
					}
				},
				fail(key: string, message: string) {
					const line = lines.get(key);
					if (line) {
						line.status = "error";
						line.message = message;
					}
				},
				stop() {
					clearInterval(interval);
					render();
					process.stdout.write("\x1b[?25h");
				},
			};
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

		async multiselect<T>(options: {
			message: string;
			options: Array<{ value: T; label: string; hint?: string }>;
			required?: boolean;
		}): Promise<T[] | symbol> {
			return clack.multiselect({
				message: options.message,
				options: options.options as Parameters<typeof clack.multiselect<T>>[0]["options"],
				required: options.required,
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
