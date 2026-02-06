import { cp, readdir, rmdir, stat } from "node:fs/promises";
import type { FilesystemError, FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { LoggerPort } from "../../domain/ports/logger-port.ts";
import { Result } from "../../shared/result.ts";

export function createBunFilesystemAdapter(logger: LoggerPort): FilesystemPort {
	return {
		async exists(path: string): Promise<boolean> {
			const exists = await Bun.file(path).exists();
			logger.debug("fs", `exists ${path} -> ${exists}`);
			return exists;
		},

		async isDirectory(path: string): Promise<boolean> {
			logger.debug("fs", `isDirectory ${path}`);
			try {
				const s = await stat(path);
				const result = s.isDirectory();
				logger.debug("fs", `-> ${result}`);
				return result;
			} catch {
				logger.debug("fs", "-> false (stat failed)");
				return false;
			}
		},

		async readFile(path: string): Promise<Result<string, FilesystemError>> {
			logger.debug("fs", `read ${path}`);
			try {
				const file = Bun.file(path);
				if (!(await file.exists())) {
					logger.debug("fs", "-> NOT_FOUND");
					return Result.err({
						code: "NOT_FOUND",
						message: "File not found",
						path,
					});
				}
				const content = await file.text();
				logger.debug("fs", `-> ${content.length} bytes`);
				return Result.ok(content);
			} catch {
				logger.debug("fs", "-> ERROR");
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to read file",
					path,
				});
			}
		},

		async writeFile(path: string, content: string): Promise<Result<void, FilesystemError>> {
			logger.debug("fs", `write ${path} (${content.length} bytes)`);
			try {
				await Bun.write(path, content);
				logger.debug("fs", "-> OK");
				return Result.ok(undefined);
			} catch {
				logger.debug("fs", "-> ERROR");
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to write file",
					path,
				});
			}
		},

		async copyFile(source: string, destination: string): Promise<Result<void, FilesystemError>> {
			logger.debug("fs", `copy ${source} -> ${destination}`);
			try {
				const file = Bun.file(source);
				if (!(await file.exists())) {
					logger.debug("fs", "-> NOT_FOUND");
					return Result.err({
						code: "NOT_FOUND",
						message: "Source file not found",
						path: source,
					});
				}
				await Bun.write(destination, file);
				logger.debug("fs", "-> OK");
				return Result.ok(undefined);
			} catch {
				logger.debug("fs", "-> ERROR");
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to copy file",
					path: source,
				});
			}
		},

		async copyDirectory(source: string, destination: string): Promise<Result<void, FilesystemError>> {
			logger.debug("fs", `copyDirectory ${source} -> ${destination}`);
			try {
				const s = await stat(source);
				if (!s.isDirectory()) {
					logger.debug("fs", "-> NOT_FOUND (not a directory)");
					return Result.err({
						code: "NOT_FOUND",
						message: "Source is not a directory",
						path: source,
					});
				}
				await cp(source, destination, { recursive: true });
				logger.debug("fs", "-> OK");
				return Result.ok(undefined);
			} catch (error) {
				logger.debug("fs", "-> ERROR");
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					return Result.err({
						code: "NOT_FOUND",
						message: "Source directory not found",
						path: source,
					});
				}
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to copy directory",
					path: source,
				});
			}
		},

		getCwd(): string {
			const cwd = process.cwd();
			logger.debug("fs", `getCwd -> ${cwd}`);
			return cwd;
		},

		async isDirectoryEmpty(path: string): Promise<Result<boolean, FilesystemError>> {
			logger.debug("fs", `isDirectoryEmpty ${path}`);
			try {
				const entries = await readdir(path);
				const isEmpty = entries.length === 0;
				logger.debug("fs", `-> ${isEmpty}`);
				return Result.ok(isEmpty);
			} catch (error) {
				logger.debug("fs", "-> ERROR");
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					return Result.err({
						code: "NOT_FOUND",
						message: "Directory not found",
						path,
					});
				}
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to check directory",
					path,
				});
			}
		},

		async removeDirectory(path: string): Promise<Result<void, FilesystemError>> {
			logger.debug("fs", `removeDirectory ${path}`);
			try {
				await rmdir(path);
				logger.debug("fs", "-> OK");
				return Result.ok(undefined);
			} catch (error) {
				logger.debug("fs", "-> ERROR");
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					return Result.err({
						code: "NOT_FOUND",
						message: "Directory not found",
						path,
					});
				}
				if (code === "ENOTEMPTY") {
					return Result.err({
						code: "UNKNOWN",
						message: "Directory is not empty",
						path,
					});
				}
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to remove directory",
					path,
				});
			}
		},
	};
}
