import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function findNearestCortexRoot(startDir: string): string | null {
	return walkUp(resolve(startDir));
}

function walkUp(dir: string): string | null {
	if (existsSync(join(dir, ".cortex", "decisions.db"))) return dir;
	const parent = dirname(dir);
	if (parent === dir) return null;
	return walkUp(parent);
}
