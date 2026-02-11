export interface SpinnerHandle {
	start(message: string): void;
	message(message: string): void;
	stop(message?: string): void;
}

export interface MultiSpinnerHandle {
	update(key: string, message: string): void;
	complete(key: string, message: string): void;
	fail(key: string, message: string): void;
	stop(): void;
}

export interface UiPort {
	readonly nonInteractive: boolean;
	intro(message: string): void;
	outro(message: string): void;
	info(message: string): void;
	success(message: string): void;
	warn(message: string): void;
	error(message: string): void;
	spinner<T>(message: string, fn: () => Promise<T>): Promise<T>;
	createSpinner(): SpinnerHandle;
	createMultiSpinner(keys: string[]): MultiSpinnerHandle;
	text(options: { message: string; placeholder?: string; defaultValue?: string }): Promise<string | symbol>;
	confirm(options: { message: string; initialValue?: boolean }): Promise<boolean | symbol>;
	select<T>(options: {
		message: string;
		options: Array<{ value: T; label: string; hint?: string }>;
	}): Promise<T | symbol>;
	multiselect<T>(options: {
		message: string;
		options: Array<{ value: T; label: string; hint?: string }>;
		required?: boolean;
	}): Promise<T[] | symbol>;
	isCancel(value: unknown): value is symbol;
	cancel(message?: string): void;
}
