import type { FilesystemPort } from "../../domain/ports/filesystem-port.ts";
import type { Result } from "../../shared/result.ts";
import { Result as R } from "../../shared/result.ts";

export interface SetConfigUpstreamInput {
	/** Path to the JSONC config file to mutate (the one `loadConfig` resolved). */
	configPath: string;
	/** A remote name to record, or `false` to persist an explicit opt-out. */
	value: string | false;
}

export interface SetConfigUpstreamDeps {
	fs: FilesystemPort;
}

/**
 * Set the `upstream` field in a JSONC config file via targeted text insertion,
 * preserving comments and formatting (mirrors the `$schema` insertion approach
 * in `init-config.ts`). If an `upstream` key already exists, its value is
 * replaced; otherwise it is inserted after `$schema` (if present) or right
 * after the opening brace.
 */
export async function setConfigUpstream(
	input: SetConfigUpstreamInput,
	deps: SetConfigUpstreamDeps,
): Promise<Result<void, Error>> {
	const { fs } = deps;

	const readResult = await fs.readFile(input.configPath);
	if (!readResult.success) {
		return R.err(new Error(`Failed to read config: ${readResult.error.message}`));
	}

	const literal = input.value === false ? "false" : JSON.stringify(input.value);
	const content = readResult.data;

	// Replace an existing `upstream` value, preserving its formatting.
	const existing = /("upstream"\s*:\s*)(?:"(?:[^"\\]|\\.)*"|true|false|null|[^\s,}]+)/;
	let updated: string;
	if (existing.test(content)) {
		updated = content.replace(existing, `$1${literal}`);
	} else {
		// Insert after $schema if present, otherwise right after the opening brace.
		const schemaLine = /("\$schema"\s*:\s*"(?:[^"\\]|\\.)*"\s*,?)/;
		if (schemaLine.test(content)) {
			updated = content.replace(schemaLine, `$1\n\t"upstream": ${literal},`);
		} else {
			updated = content.replace(/\{/, `{\n\t"upstream": ${literal},`);
		}
	}

	const writeResult = await fs.writeFile(input.configPath, updated);
	if (!writeResult.success) {
		return R.err(new Error(`Failed to write config: ${writeResult.error.message}`));
	}

	return R.ok(undefined);
}
