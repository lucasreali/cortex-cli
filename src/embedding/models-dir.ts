import { userCortexDir } from "@/support/cortex-home";

export function modelsDir(): string {
	return userCortexDir("models", process.env.CORTEX_MODELS_DIR);
}
