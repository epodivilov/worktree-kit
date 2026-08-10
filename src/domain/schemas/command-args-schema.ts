import * as v from "valibot";

export const CreateArgsSchema = v.object({
	branch: v.optional(v.string()),
	base: v.optional(v.string()),
	"dry-run": v.optional(v.boolean(), false),
});

export type CreateArgs = v.InferOutput<typeof CreateArgsSchema>;

export const RemoveArgsSchema = v.object({
	branch: v.optional(v.pipe(v.string(), v.nonEmpty("Branch name cannot be empty"))),
	"delete-branch": v.optional(v.boolean()),
	"delete-remote-branch": v.optional(v.boolean()),
	force: v.optional(v.boolean(), false),
	yes: v.optional(v.boolean(), false),
	"dry-run": v.optional(v.boolean(), false),
});

export type RemoveArgs = v.InferOutput<typeof RemoveArgsSchema>;

const JOBS_MESSAGE = "--jobs must be a positive integer";

export const UpdateArgsSchema = v.object({
	branch: v.optional(v.string()),
	"dry-run": v.optional(v.boolean(), false),
	cleanup: v.optional(v.boolean(), false),
	// Max worktrees to rebase concurrently. citty hands the flag over as a string
	// (or a number if already numeric); coerce, then reject anything that is not a
	// positive integer as an argument validation error.
	jobs: v.optional(
		v.pipe(
			v.union([v.string(), v.number()]),
			v.transform((value) => (typeof value === "number" ? value : Number(value))),
			v.number(JOBS_MESSAGE),
			v.integer(JOBS_MESSAGE),
			v.minValue(1, JOBS_MESSAGE),
		),
	),
});

export type UpdateArgs = v.InferOutput<typeof UpdateArgsSchema>;

export const CleanupArgsSchema = v.object({
	force: v.optional(v.boolean(), false),
	yes: v.optional(v.boolean(), false),
	"dry-run": v.optional(v.boolean(), false),
});

export type CleanupArgs = v.InferOutput<typeof CleanupArgsSchema>;

export const SyncArgsSchema = v.object({
	branch: v.optional(v.string()),
	"dry-run": v.optional(v.boolean(), false),
	force: v.optional(v.boolean(), false),
});

export type SyncArgs = v.InferOutput<typeof SyncArgsSchema>;
