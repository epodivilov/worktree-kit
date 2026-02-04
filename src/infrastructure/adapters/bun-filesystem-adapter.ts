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

		getCwd(): string {
			const cwd = process.cwd();
			logger.debug("fs", `getCwd -> ${cwd}`);
			return cwd;
		},
	};
}
