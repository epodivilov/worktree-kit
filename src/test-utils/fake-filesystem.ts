import type { FilesystemError, FilesystemPort } from "../domain/ports/filesystem-port.ts";
import { Result } from "../shared/result.ts";

export interface FakeFilesystemOptions {
	files?: Record<string, string>;
	directories?: string[];
	cwd?: string;
	overrides?: Partial<FilesystemPort>;
}

export function createFakeFilesystem(options: FakeFilesystemOptions = {}): FilesystemPort {
	const { files = {}, directories = [], cwd = "/fake/project", overrides = {} } = options;
	const store = new Map<string, string>(Object.entries(files));
	const dirs = new Set<string>(directories);

	const base: FilesystemPort = {
		async exists(path: string): Promise<boolean> {
			return store.has(path) || dirs.has(path);
		},

		async isDirectory(path: string): Promise<boolean> {
			return dirs.has(path);
		},

		async readFile(path: string): Promise<Result<string, FilesystemError>> {
			const content = store.get(path);
			if (content === undefined) {
				return Result.err({ code: "NOT_FOUND", message: "File not found", path });
			}
			return Result.ok(content);
		},

		async writeFile(path: string, content: string): Promise<Result<void, FilesystemError>> {
			store.set(path, content);
			return Result.ok(undefined);
		},

		async copyFile(source: string, destination: string): Promise<Result<void, FilesystemError>> {
			const content = store.get(source);
			if (content === undefined) {
				return Result.err({ code: "NOT_FOUND", message: "Source file not found", path: source });
			}
			store.set(destination, content);
			return Result.ok(undefined);
		},

		async copyDirectory(source: string, destination: string): Promise<Result<void, FilesystemError>> {
			if (!dirs.has(source)) {
				return Result.err({ code: "NOT_FOUND", message: "Source directory not found", path: source });
			}
			dirs.add(destination);
			// Copy all files under the source directory to the destination
			for (const [key, value] of store.entries()) {
				if (key.startsWith(`${source}/`)) {
					const relativePath = key.slice(source.length);
					store.set(`${destination}${relativePath}`, value);
				}
			}
			// Copy nested directories
			for (const dir of dirs) {
				if (dir.startsWith(`${source}/`)) {
					const relativePath = dir.slice(source.length);
					dirs.add(`${destination}${relativePath}`);
				}
			}
			return Result.ok(undefined);
		},

		getCwd(): string {
			return cwd;
		},

		async isDirectoryEmpty(path: string): Promise<Result<boolean, FilesystemError>> {
			// Check if any stored paths start with this directory
			for (const key of store.keys()) {
				if (key.startsWith(`${path}/`)) {
					return Result.ok(false);
				}
			}
			return Result.ok(true);
		},

		async removeDirectory(path: string): Promise<Result<void, FilesystemError>> {
			// Check if directory has any files
			for (const key of store.keys()) {
				if (key.startsWith(`${path}/`)) {
					return Result.err({ code: "UNKNOWN", message: "Directory is not empty", path });
				}
			}
			return Result.ok(undefined);
		},
	};

	return { ...base, ...overrides };
}
