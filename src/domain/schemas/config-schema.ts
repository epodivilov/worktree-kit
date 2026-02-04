import * as v from "valibot";

export const WorktreeConfigSchema = v.object({
	rootDir: v.string(),
	copy: v.optional(v.array(v.string()), []),
});

export type WorktreeConfigInput = v.InferInput<typeof WorktreeConfigSchema>;
export type WorktreeConfigOutput = v.InferOutput<typeof WorktreeConfigSchema>;
