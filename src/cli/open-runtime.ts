import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildRuntime, type CortexRuntime } from "@/app/runtime";
import { getRepoRoot } from "@/git";
import { failure } from "./style";

export async function openInitializedRuntime(
	cwd: string,
): Promise<CortexRuntime | null> {
	const root = getRepoRoot(cwd) ?? resolve(cwd);
	if (!existsSync(join(root, ".cortex", "decisions.db"))) {
		console.error(failure("Cortex is not initialized here — run: cortex init"));
		return null;
	}
	return buildRuntime(cwd);
}
