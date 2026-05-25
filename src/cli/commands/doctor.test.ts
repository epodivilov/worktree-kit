import { describe, expect, test } from "bun:test";
import type { HealthIssue } from "../../domain/entities/health-check.ts";
import { describeIssue } from "./doctor.ts";

const ROOT = "/fake/project";

describe("describeIssue", () => {
	test("renders path-drift with branch, actual and expected paths", () => {
		const issue: HealthIssue = {
			type: "path-drift",
			severity: "warning",
			worktreePath: `${ROOT}/.worktrees/old-name`,
			branch: "feature",
			expectedPath: `${ROOT}/.worktrees/feature`,
		};

		const line = describeIssue(issue, ROOT);

		expect(line).toContain("worktree path drift");
		expect(line).toContain("feature");
		expect(line).toContain(".worktrees/old-name");
		expect(line).toContain("expected");
		expect(line).toContain(".worktrees/feature");
	});
});
