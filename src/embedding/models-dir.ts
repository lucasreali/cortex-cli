import { homedir } from "node:os";
import { join } from "node:path";

export function modelsDir(): string {
	return process.env.CORTEX_MODELS_DIR ?? join(homedir(), ".cortex", "models");
}
