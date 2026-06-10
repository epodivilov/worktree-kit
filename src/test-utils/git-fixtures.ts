import { realpath } from "node:fs/promises";
import { join } from "node:path";

async function configureUser(repoPath: string): Promise<void> {
	await Bun.$`git -C ${repoPath} config user.name "Test"`.quiet();
	await Bun.$`git -C ${repoPath} config user.email "test@test.com"`.quiet();
}

/** Single-commit local repo with a deterministic "main" default branch. */
export async function initTestRepo(parentDir: string): Promise<string> {
	const repoPath = join(parentDir, "repo");
	await Bun.$`git init -b main ${repoPath}`.quiet();
	await configureUser(repoPath);
	await Bun.write(join(repoPath, "README.md"), "test");
	await Bun.$`git -C ${repoPath} add .`.quiet();
	await Bun.$`git -C ${repoPath} commit -m "Initial commit"`.quiet();
	return repoPath;
}

/** Repo with no commits yet (unborn HEAD). Path is canonical (realpath). */
export async function initUnbornRepo(parentDir: string): Promise<string> {
	const repoPath = join(parentDir, "unborn");
	await Bun.$`git init -b main ${repoPath}`.quiet();
	await configureUser(repoPath);
	return realpath(repoPath);
}

export interface RemoteFixture {
	/** Bare repository acting as `origin`. Canonical absolute path — relative remote URLs break inside linked worktrees. */
	readonly remotePath: string;
	/** Clone whose `main` tracks `origin/main`. Canonical absolute path. */
	readonly repoPath: string;
	/** Create a branch (optionally with its own commit) and push it with tracking — without `-u` a branch can never become [gone]. */
	addTrackedBranch(name: string, opts?: { withCommit?: boolean }): Promise<void>;
	/** Delete the branch on the remote; after a fetch with prune the local branch shows as [gone]. */
	deleteRemoteBranch(name: string): Promise<void>;
}

/** Bare remote + tracking clone: the minimal setup for fetch/prune/gone-branch scenarios. */
export async function createRemoteFixture(parentDir: string): Promise<RemoteFixture> {
	const remoteDir = join(parentDir, "remote.git");
	await Bun.$`git init --bare -b main ${remoteDir}`.quiet();
	const remotePath = await realpath(remoteDir);

	const repoDir = join(parentDir, "repo");
	await Bun.$`git clone ${remotePath} ${repoDir}`.quiet();
	const repoPath = await realpath(repoDir);
	await configureUser(repoPath);
	// A clone of an empty remote starts on an unborn HEAD named after the
	// user's init.defaultBranch — pin it to "main" before the first commit.
	await Bun.$`git -C ${repoPath} symbolic-ref HEAD refs/heads/main`.quiet();
	await Bun.write(join(repoPath, "README.md"), "test");
	await Bun.$`git -C ${repoPath} add .`.quiet();
	await Bun.$`git -C ${repoPath} commit -m "Initial commit"`.quiet();
	await Bun.$`git -C ${repoPath} push -u origin main`.quiet();

	return {
		remotePath,
		repoPath,
		async addTrackedBranch(name: string, opts: { withCommit?: boolean } = {}): Promise<void> {
			await Bun.$`git -C ${repoPath} branch ${name}`.quiet();
			if (opts.withCommit) {
				await Bun.$`git -C ${repoPath} checkout ${name}`.quiet();
				await Bun.write(join(repoPath, `${name}.txt`), name);
				await Bun.$`git -C ${repoPath} add .`.quiet();
				await Bun.$`git -C ${repoPath} commit -m ${`commit on ${name}`}`.quiet();
				await Bun.$`git -C ${repoPath} checkout main`.quiet();
			}
			await Bun.$`git -C ${repoPath} push -u origin ${name}`.quiet();
		},
		async deleteRemoteBranch(name: string): Promise<void> {
			await Bun.$`git -C ${repoPath} push origin --delete ${name}`.quiet();
		},
	};
}
