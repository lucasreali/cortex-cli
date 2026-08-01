import { homedir } from "node:os";
import { join } from "node:path";

// The per-user cache, distinct from the per-project <repo>/.cortex store: it
// holds the model, the grammar, the onnxruntime assets and the daemon's
// socket, all of which are rebuildable and shared across every project.
export function userCortexDir(
	subdirectory: string,
	override: string | undefined,
): string {
	return override ?? join(homedir(), ".cortex", subdirectory);
}
