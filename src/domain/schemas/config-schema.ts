import * as v from "valibot";

const HooksInputSchema = v.object({
	"post-create": v.optional(v.array(v.string())),
});

export const WorktreeConfigSchema = v.pipe(
	v.object({
		rootDir: v.string(),
		copy: v.optional(v.array(v.string())),
		hooks: v.optional(HooksInputSchema),
		defaultBase: v.optional(v.picklist(["current", "default", "ask"])),
	}),
	v.transform((input) => ({
		rootDir: input.rootDir,
		copy: input.copy ?? [],
		hooks: {
			"post-create": input.hooks?.["post-create"] ?? [],
		},
		defaultBase: input.defaultBase ?? "ask",
	})),
);

export type WorktreeConfigInput = v.InferInput<typeof WorktreeConfigSchema>;
export type WorktreeConfigOutput = v.InferOutput<typeof WorktreeConfigSchema>;
