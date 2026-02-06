import type { Result } from "../../shared/result.ts";

export interface FilesystemError {
	readonly code: "NOT_FOUND" | "PERMISSION_DENIED" | "ALREADY_EXISTS" | "UNKNOWN";
	readonly message: string;
	readonly path: string;
}

export interface FilesystemPort {
	exists(path: string): Promise<boolean>;
	isDirectory(path: string): Promise<boolean>;
	readFile(path: string): Promise<Result<string, FilesystemError>>;
	writeFile(path: string, content: string): Promise<Result<void, FilesystemError>>;
	copyFile(source: string, destination: string): Promise<Result<void, FilesystemError>>;
	copyDirectory(source: string, destination: string): Promise<Result<void, FilesystemError>>;
	glob(pattern: string, options?: { cwd?: string }): Promise<string[]>;
	getCwd(): string;
	isDirectoryEmpty(path: string): Promise<Result<boolean, FilesystemError>>;
	removeDirectory(path: string): Promise<Result<void, FilesystemError>>;
}
