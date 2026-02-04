export interface HooksConfig {
	readonly "post-create": readonly string[];
}

export interface WorktreeConfig {
	readonly rootDir: string;
	readonly copy: readonly string[];
	readonly hooks: HooksConfig;
}
