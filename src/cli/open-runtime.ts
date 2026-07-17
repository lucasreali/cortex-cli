import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRepoRoot } from "@/git";
import { buildRuntime, type CortexRuntime } from "@/mcp/runtime";

export function openInitializedRuntime(cwd: string): CortexRuntime | null {
	const root = getRepoRoot(cwd) ?? resolve(cwd);
	if (!existsSync(join(root, ".cortex", "decisions.db"))) {
		console.error("Cortex is not initialized here. Run: cortex init");
		return null;
	}
	return buildRuntime(cwd);
}

export function cortexDirOf(runtime: CortexRuntime): string {
	return join(runtime.repoRoot, ".cortex");
}
