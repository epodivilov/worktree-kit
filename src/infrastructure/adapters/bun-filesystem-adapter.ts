import type { FilesystemError, FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import { Result } from "../../shared/result.ts";

export function createBunFilesystemAdapter(): FilesystemPort {
	return {
		async exists(path: string): Promise<boolean> {
			return Bun.file(path).exists();
		},

		async readFile(path: string): Promise<Result<string, FilesystemError>> {
			try {
				const file = Bun.file(path);
				if (!(await file.exists())) {
					return Result.err({
						code: "NOT_FOUND",
						message: "File not found",
						path,
					});
				}
				const content = await file.text();
				return Result.ok(content);
			} catch {
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to read file",
					path,
				});
			}
		},

		async writeFile(path: string, content: string): Promise<Result<void, FilesystemError>> {
			try {
				await Bun.write(path, content);
				return Result.ok(undefined);
			} catch {
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to write file",
					path,
				});
			}
		},

		async copyFile(source: string, destination: string): Promise<Result<void, FilesystemError>> {
			try {
				const file = Bun.file(source);
				if (!(await file.exists())) {
					return Result.err({
						code: "NOT_FOUND",
						message: "Source file not found",
						path: source,
					});
				}
				await Bun.write(destination, file);
				return Result.ok(undefined);
			} catch {
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to copy file",
					path: source,
				});
			}
		},

		getCwd(): string {
			return process.cwd();
		},
	};
}
