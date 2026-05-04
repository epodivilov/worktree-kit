import type { FilesystemError, FilesystemPort } from "../domain/ports/filesystem-port.ts";
import { Result } from "../shared/result.ts";

export interface FakeFilesystemOptions {
	files?: Record<string, string>;
	directories?: string[];
	symlinks?: Record<string, string>;
	brokenSymlinks?: string[];
	cwd?: string;
	overrides?: Partial<FilesystemPort>;
}

export function createFakeFilesystem(options: FakeFilesystemOptions = {}): FilesystemPort {
	const {
		files = {},
		directories = [],
		symlinks = {},
		brokenSymlinks = [],
		cwd = "/fake/project",
		overrides = {},
	} = options;
	const store = new Map<string, string>(Object.entries(files));
	const dirs = new Set<string>(directories);
	const symlinkStore = new Map<string, string>(Object.entries(symlinks));
	const brokenSymlinkSet = new Set<string>(brokenSymlinks);
	for (const broken of brokenSymlinkSet) {
		if (!symlinkStore.has(broken)) {
			symlinkStore.set(broken, "<missing>");
		}
	}

	const base: FilesystemPort = {
		async exists(path: string): Promise<boolean> {
			return store.has(path) || dirs.has(path) || (symlinkStore.has(path) && !brokenSymlinkSet.has(path));
		},

		async isDirectory(path: string): Promise<boolean> {
			return dirs.has(path);
		},

		async isSymlink(path: string): Promise<boolean> {
			return symlinkStore.has(path);
		},

		async isSymlinkBroken(path: string): Promise<boolean> {
			return brokenSymlinkSet.has(path);
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

		async createSymlink(target: string, linkPath: string): Promise<Result<void, FilesystemError>> {
			if (!store.has(target) && !dirs.has(target)) {
				return Result.err({ code: "NOT_FOUND", message: "Target not found", path: target });
			}
			store.set(linkPath, `symlink:${target}`);
			return Result.ok(undefined);
		},

		async glob(pattern: string, options?: { cwd?: string }): Promise<string[]> {
			const base = options?.cwd ?? cwd;
			// Convert glob pattern to regex using placeholders to avoid conflicts
			const QUESTION = "<<Q>>";
			const GLOBSTAR_SLASH = "<<GS>>";
			const GLOBSTAR = "<<G>>";
			const escaped = pattern
				.replace(/\./g, "\\.")
				.replace(/\?/g, QUESTION)
				.replace(/\*\*\//g, GLOBSTAR_SLASH)
				.replace(/\*\*/g, GLOBSTAR)
				.replace(/\*/g, "[^/]*")
				.replaceAll(QUESTION, ".")
				.replaceAll(GLOBSTAR_SLASH, "(.*/)?")
				.replaceAll(GLOBSTAR, ".*");
			const regex = new RegExp(`^${base}/${escaped}$`);

			const matches: string[] = [];
			for (const path of store.keys()) {
				if (regex.test(path)) {
					matches.push(path);
				}
			}
			for (const dir of dirs) {
				if (regex.test(dir)) {
					matches.push(dir);
				}
			}
			return matches.sort();
		},

		async listDirectory(path: string): Promise<string[]> {
			const prefix = `${path}/`;
			const entries = new Set<string>();
			for (const key of store.keys()) {
				if (key.startsWith(prefix)) {
					const rest = key.slice(prefix.length);
					const head = rest.split("/")[0];
					if (head) entries.add(`${path}/${head}`);
				}
			}
			for (const dir of dirs) {
				if (dir.startsWith(prefix)) {
					const rest = dir.slice(prefix.length);
					const head = rest.split("/")[0];
					if (head) entries.add(`${path}/${head}`);
				}
			}
			for (const link of symlinkStore.keys()) {
				if (link.startsWith(prefix)) {
					const rest = link.slice(prefix.length);
					const head = rest.split("/")[0];
					if (head) entries.add(`${path}/${head}`);
				}
			}
			return [...entries].sort();
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

		async rename(from: string, to: string): Promise<Result<void, FilesystemError>> {
			const content = store.get(from);
			if (content === undefined) {
				return Result.err({ code: "NOT_FOUND", message: "File not found", path: from });
			}
			store.set(to, content);
			store.delete(from);
			return Result.ok(undefined);
		},
	};

	return { ...base, ...overrides };
}
