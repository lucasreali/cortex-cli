import { GemmaProvider } from "./gemma-provider";
import { GEMMA_MODEL } from "./model";

export function createProvider(modelId: string): GemmaProvider {
	if (modelId === GEMMA_MODEL.modelId) return new GemmaProvider();
	throw new Error(
		`no embedding provider implements model_id "${modelId}" (pinned in .cortex/config); ` +
			`available: ${GEMMA_MODEL.modelId}`,
	);
}
