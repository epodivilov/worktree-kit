export interface Worktree {
	readonly path: string;
	readonly branch: string;
	readonly head: string;
	readonly isMain: boolean;
}
