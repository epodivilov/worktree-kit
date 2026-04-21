type SemverTuple = readonly [number, number, number];

function parse(version: string): SemverTuple | null {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

export function isNewer(remote: string, current: string): boolean {
	const r = parse(remote);
	const c = parse(current);
	if (!r || !c) return false;

	for (let i = 0; i < 3; i++) {
		const a = r[i] as number;
		const b = c[i] as number;
		if (a > b) return true;
		if (a < b) return false;
	}
	return false;
}
