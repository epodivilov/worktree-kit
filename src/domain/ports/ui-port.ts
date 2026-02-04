export interface UiPort {
	intro(message: string): void;
	outro(message: string): void;
	info(message: string): void;
	success(message: string): void;
	warn(message: string): void;
	error(message: string): void;
	spinner<T>(message: string, fn: () => Promise<T>): Promise<T>;
	text(options: { message: string; placeholder?: string; defaultValue?: string }): Promise<string | symbol>;
	confirm(options: { message: string; initialValue?: boolean }): Promise<boolean | symbol>;
	select<T>(options: {
		message: string;
		options: Array<{ value: T; label: string; hint?: string }>;
	}): Promise<T | symbol>;
	isCancel(value: unknown): value is symbol;
	cancel(message?: string): void;
}
