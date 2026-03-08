import * as v from "valibot";

const HooksInputSchema = v.object({
	"post-create": v.optional(v.array(v.string())),
	"pre-remove": v.optional(v.array(v.string())),
	"post-update": v.optional(v.array(v.string())),
	"on-conflict": v.optional(v.array(v.string())),
});

const CreateCommandConfigSchema = v.optional(
	v.object({
		base: v.optional(v.string()),
	}),
);

const RemoveCommandConfigSchema = v.optional(
	v.object({
		deleteBranch: v.optional(v.boolean()),
		deleteRemoteBranch: v.optional(v.boolean()),
	}),
);

export const WorktreeConfigSchema = v.pipe(
	v.object({
		$schema: v.optional(v.string()),
		rootDir: v.string(),
		copy: v.optional(v.array(v.string())),
		symlinks: v.optional(v.array(v.string())),
		hooks: v.optional(HooksInputSchema),
		defaultBase: v.optional(v.picklist(["current", "default", "ask"])),
		create: CreateCommandConfigSchema,
		remove: RemoveCommandConfigSchema,
	}),
	v.transform((input) => ({
		rootDir: input.rootDir,
		copy: input.copy ?? [],
		symlinks: input.symlinks ?? [],
		hooks: {
			"post-create": input.hooks?.["post-create"] ?? [],
			"pre-remove": input.hooks?.["pre-remove"] ?? [],
			"post-update": input.hooks?.["post-update"] ?? [],
			"on-conflict": input.hooks?.["on-conflict"] ?? [],
		},
		defaultBase: input.defaultBase ?? "ask",
		create: {
			base: input.create?.base,
		},
		remove: {
			deleteBranch: input.remove?.deleteBranch,
			deleteRemoteBranch: input.remove?.deleteRemoteBranch,
		},
	})),
);

export type WorktreeConfigInput = v.InferInput<typeof WorktreeConfigSchema>;
export type WorktreeConfigOutput = v.InferOutput<typeof WorktreeConfigSchema>;
