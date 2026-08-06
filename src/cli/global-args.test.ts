import { describe, expect, test } from "bun:test";
import type { ArgsDef } from "citty";
import type { Container } from "../infrastructure/container.ts";
import { cleanupCommand } from "./commands/cleanup.ts";
import { configCommand } from "./commands/config.ts";
import { createCommand } from "./commands/create.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { initCommand } from "./commands/init.ts";
import { listCommand } from "./commands/list.ts";
import { removeCommand } from "./commands/remove.ts";
import { selfUpdateCommand } from "./commands/self-update.ts";
import { syncCommand } from "./commands/sync.ts";
import { updateCommand } from "./commands/update.ts";

// Command factories only close over the container; they never touch it at
// construction time, so a bare cast is enough to inspect the arg declarations.
const container = {} as Container;

// citty's `CommandDef<T>` is contravariant in its arg type, so the concrete
// command defs can't share a single `CommandDef` array element type. We only
// need the `args` bag, so read it structurally.
type WithArgs = { args?: unknown };

function argsOf(command: WithArgs): ArgsDef {
	return (command.args ?? {}) as ArgsDef;
}

const commands: Array<[string, WithArgs]> = [
	["create", createCommand(container)],
	["list", listCommand(container)],
	["remove", removeCommand(container)],
	["update", updateCommand(container)],
	["self-update", selfUpdateCommand(container)],
	["init", initCommand(container)],
	["cleanup", cleanupCommand(container)],
	["config", configCommand(container)],
	["doctor", doctorCommand(container)],
	["sync", syncCommand(container)],
];

describe("global flags are declared on every subcommand (R1)", () => {
	for (const [name, command] of commands) {
		test(`${name} declares --non-interactive and --verbose as booleans`, () => {
			const args = argsOf(command);
			expect(args["non-interactive"]).toMatchObject({ type: "boolean" });
			expect(args.verbose).toMatchObject({ type: "boolean" });
		});
	}

	test("config show (nested leaf) declares --non-interactive and --verbose as booleans", () => {
		const config = configCommand(container);
		const subCommands = config.subCommands as unknown as Record<string, WithArgs | undefined>;
		const show = subCommands.show;
		expect(show).toBeDefined();
		const args = argsOf(show ?? {});
		expect(args["non-interactive"]).toMatchObject({ type: "boolean" });
		expect(args.verbose).toMatchObject({ type: "boolean" });
	});
});
