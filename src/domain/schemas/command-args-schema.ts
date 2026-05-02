import * as v from "valibot";

export const CreateArgsSchema = v.object({
	branch: v.optional(v.string()),
	base: v.optional(v.string()),
	"dry-run": v.optional(v.boolean(), false),
});

export type CreateArgs = v.InferOutput<typeof CreateArgsSchema>;

export const RemoveArgsSchema = v.object({
	branch: v.optional(v.string()),
	"delete-branch": v.optional(v.boolean()),
	"delete-remote-branch": v.optional(v.boolean()),
	force: v.optional(v.boolean(), false),
	"dry-run": v.optional(v.boolean(), false),
});

export type RemoveArgs = v.InferOutput<typeof RemoveArgsSchema>;

export const UpdateArgsSchema = v.object({
	branch: v.optional(v.string()),
	"dry-run": v.optional(v.boolean(), false),
	cleanup: v.optional(v.boolean(), false),
});

export type UpdateArgs = v.InferOutput<typeof UpdateArgsSchema>;

export const CleanupArgsSchema = v.object({
	force: v.optional(v.boolean(), false),
	"dry-run": v.optional(v.boolean(), false),
});

export type CleanupArgs = v.InferOutput<typeof CleanupArgsSchema>;
