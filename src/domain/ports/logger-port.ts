export type LogCategory = "git" | "shell" | "fs" | "app";

export interface LoggerPort {
	debug(category: LogCategory, message: string): void;
	isVerbose(): boolean;
}
