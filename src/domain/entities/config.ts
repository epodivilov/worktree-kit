export interface HooksConfig {
	readonly "post-create": readonly string[];
	readonly "pre-remove": readonly string[];
	readonly "post-update": readonly string[];
	readonly "on-conflict": readonly string[];
}

export type DefaultBase = "current" | "default" | "ask";

export interface CreateCommandConfig {
	readonly base?: string;
}

export interface RemoveCommandConfig {
	readonly deleteBranch?: boolean;
	readonly deleteRemoteBranch?: boolean;
}

export interface WorktreeConfig {
	readonly rootDir: string;
	readonly copy: readonly string[];
	readonly symlinks: readonly string[];
	readonly hooks: HooksConfig;
	readonly defaultBase: DefaultBase;
	readonly create: CreateCommandConfig;
	readonly remove: RemoveCommandConfig;
}
