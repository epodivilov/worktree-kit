export interface HooksConfig {
	readonly "post-create": readonly string[];
}

export type DefaultBase = "current" | "default" | "ask";

export interface WorktreeConfig {
	readonly rootDir: string;
	readonly copy: readonly string[];
	readonly hooks: HooksConfig;
	readonly defaultBase: DefaultBase;
}
