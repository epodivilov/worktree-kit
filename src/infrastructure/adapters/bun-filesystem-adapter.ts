import { cp, lstat, mkdir, readdir, rename, rmdir, stat, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { FilesystemError, FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { LoggerPort } from "../../domain/ports/logger-port.ts";
import { Result } from "../../shared/result.ts";

export function createBunFilesystemAdapter(logger: LoggerPort): FilesystemPort {
	return {
		async exists(path: string): Promise<boolean> {
			try {
				await stat(path);
				logger.debug("fs", `exists ${path} -> true`);
				return true;
			} catch {
				logger.debug("fs", `exists ${path} -> false`);
				return false;
			}
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

		async isSymlink(path: string): Promise<boolean> {
			logger.debug("fs", `isSymlink ${path}`);
			try {
				const s = await lstat(path);
				const result = s.isSymbolicLink();
				logger.debug("fs", `-> ${result}`);
				return result;
			} catch {
				logger.debug("fs", "-> false (lstat failed)");
				return false;
			}
		},

		async isSymlinkBroken(path: string): Promise<boolean> {
			logger.debug("fs", `isSymlinkBroken ${path}`);
			try {
				const ls = await lstat(path);
				if (!ls.isSymbolicLink()) {
					logger.debug("fs", "-> false (not a symlink)");
					return false;
				}
				try {
					await stat(path);
					logger.debug("fs", "-> false (target exists)");
					return false;
				} catch {
					logger.debug("fs", "-> true (target missing)");
					return true;
				}
			} catch {
				logger.debug("fs", "-> false (lstat failed)");
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

		async createSymlink(target: string, linkPath: string): Promise<Result<void, FilesystemError>> {
			const relativeTarget = relative(dirname(linkPath), target);
			logger.debug("fs", `symlink ${relativeTarget} -> ${linkPath}`);
			try {
				await mkdir(dirname(linkPath), { recursive: true });
				await symlink(relativeTarget, linkPath);
				logger.debug("fs", "-> OK");
				return Result.ok(undefined);
			} catch (error) {
				logger.debug("fs", "-> ERROR");
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "EEXIST") {
					return Result.err({
						code: "ALREADY_EXISTS",
						message: "Symlink already exists",
						path: linkPath,
					});
				}
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to create symlink",
					path: linkPath,
				});
			}
		},

		async glob(pattern: string, options?: { cwd?: string }): Promise<string[]> {
			const cwd = options?.cwd ?? process.cwd();
			logger.debug("fs", `glob ${pattern} in ${cwd}`);
			try {
				const g = new Bun.Glob(pattern);
				const matches: string[] = [];
				for await (const file of g.scan({ cwd, absolute: true, dot: true })) {
					matches.push(file);
				}
				matches.sort();
				logger.debug("fs", `-> ${matches.length} matches`);
				return matches;
			} catch {
				logger.debug("fs", "-> ERROR");
				return [];
			}
		},

		async listDirectory(path: string): Promise<string[]> {
			logger.debug("fs", `listDirectory ${path}`);
			try {
				const entries = await readdir(path);
				const absolute = entries.map((entry) => join(path, entry)).sort();
				logger.debug("fs", `-> ${absolute.length} entries`);
				return absolute;
			} catch {
				logger.debug("fs", "-> [] (readdir failed)");
				return [];
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

		async rename(from: string, to: string): Promise<Result<void, FilesystemError>> {
			logger.debug("fs", `rename ${from} -> ${to}`);
			try {
				await rename(from, to);
				logger.debug("fs", "-> OK");
				return Result.ok(undefined);
			} catch (error) {
				logger.debug("fs", "-> ERROR");
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					return Result.err({
						code: "NOT_FOUND",
						message: "File not found",
						path: from,
					});
				}
				return Result.err({
					code: "UNKNOWN",
					message: "Failed to rename file",
					path: from,
				});
			}
		},
	};
}
