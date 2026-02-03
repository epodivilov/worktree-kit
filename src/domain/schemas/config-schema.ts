import * as v from "valibot";

export const WorktreeConfigSchema = v.object({
	files: v.optional(v.array(v.string()), []),
	directories: v.optional(v.array(v.string()), []),
	ignore: v.optional(v.array(v.string()), ["node_modules", ".git"]),
});

export type WorktreeConfigInput = v.InferInput<typeof WorktreeConfigSchema>;
export type WorktreeConfigOutput = v.InferOutput<typeof WorktreeConfigSchema>;
