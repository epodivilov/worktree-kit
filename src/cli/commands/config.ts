import { defineCommand } from "citty";
import pc from "picocolors";
import { loadConfig } from "../../application/use-cases/load-config.ts";
import {
	type ConfigSource,
	type ProvenanceEntry,
	resolveConfigProvenance,
} from "../../application/use-cases/resolve-config-provenance.ts";
import { LOCAL_CONFIG_FILENAME } from "../../domain/constants.ts";
import type { Container } from "../../infrastructure/container.ts";
import { Result } from "../../shared/result.ts";
import { resolveGlobalConfigPath } from "../../shared/xdg-paths.ts";
import { EXIT_FAILURE } from "../exit-codes.ts";
import { CommandError, runCommand } from "../run-command.ts";

function formatValue(value: unknown): string {
	if (value === undefined) return "(unset)";
	return JSON.stringify(value);
}

function colorSource(source: ConfigSource): string {
	switch (source) {
		case "global":
			return pc.cyan(source);
		case "repo":
			return pc.green(source);
		case "local":
			return pc.magenta(source);
		case "default":
			return pc.dim(source);
	}
}

function buildHumanOutput(fields: Record<string, ProvenanceEntry>): string {
	const entries = Object.entries(fields);
	const formatted = entries.map(([path, entry]) => ({
		path,
		entry,
		left: `${path}: ${formatValue(entry.value)}`,
	}));
	const maxLeft = formatted.reduce((acc, item) => Math.max(acc, item.left.length), 0);

	const lines = formatted.map(({ left, entry }) => {
		const padded = left.padEnd(maxLeft, " ");
		if (entry.source === "default") {
			return pc.dim(`${padded}    ← ${entry.source}`);
		}
		return `${padded}    ← ${colorSource(entry.source)}`;
	});

	return lines.join("\n");
}

function buildSourcesHeader(sources: { global: string | null; repo: string; local: string | null }): string {
	const globalPath = resolveGlobalConfigPath();
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const displayGlobalPath = home && globalPath.startsWith(home) ? `~${globalPath.slice(home.length)}` : globalPath;
	const globalHint = pc.dim(`(not found: ${displayGlobalPath})`);
	const localHint = pc.dim(`(not found: ${LOCAL_CONFIG_FILENAME})`);
	const lines = [
		`${pc.bold("Sources:")}`,
		`  ${colorSource("global")}: ${sources.global ?? globalHint}`,
		`  ${colorSource("repo")}:   ${sources.repo}`,
		`  ${colorSource("local")}:  ${sources.local ?? localHint}`,
	];
	return lines.join("\n");
}

function showCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "show",
			description: "Show effective config with provenance",
		},
		args: {
			json: {
				type: "boolean",
				default: false,
				description: "Output as JSON",
			},
		},
		async run({ args }) {
			const { ui, fs, git } = container;

			if (args.json) {
				try {
					const loadResult = await loadConfig({ fs, git });
					if (Result.isErr(loadResult)) {
						process.stderr.write(`${JSON.stringify({ error: loadResult.error.message })}\n`);
						process.exit(EXIT_FAILURE);
					}

					const provenance = resolveConfigProvenance(loadResult.data);
					const json = JSON.stringify(provenance, (_key, value) => (value === undefined ? null : value));
					process.stdout.write(`${json}\n`);
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					process.stderr.write(`${JSON.stringify({ error: message })}\n`);
					process.exit(EXIT_FAILURE);
				}
				return;
			}

			ui.intro("worktree-kit config show");

			await runCommand(async () => {
				const loadResult = await loadConfig({ fs, git });
				if (Result.isErr(loadResult)) {
					throw new CommandError(loadResult.error.message, EXIT_FAILURE);
				}

				const provenance = resolveConfigProvenance(loadResult.data);

				ui.info(buildSourcesHeader(provenance.sources));
				ui.info(buildHumanOutput(provenance.fields));

				ui.outro("Done!");
			}, ui);
		},
	});
}

export function configCommand(container: Container) {
	return defineCommand({
		meta: {
			name: "config",
			description: "Inspect worktree-kit configuration",
		},
		subCommands: {
			show: showCommand(container),
		},
	});
}
