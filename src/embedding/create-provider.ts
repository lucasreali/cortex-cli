import { GemmaProvider, type GemmaProviderOptions } from "./gemma-provider";
import { GEMMA_MODEL } from "./model";
import type { EmbeddingProvider } from "./provider";
import { SharedEmbeddingProvider } from "./shared-provider";

export interface CreateProviderOptions {
	shared?: boolean;
}

export function createProvider(
	modelId: string,
	options: CreateProviderOptions = {},
): EmbeddingProvider {
	const direct = createDirectProvider(modelId);
	if (options.shared !== true || daemonDisabled()) return direct;
	return new SharedEmbeddingProvider(direct);
}

export function createDirectProvider(
	modelId: string,
	options: GemmaProviderOptions = {},
): GemmaProvider {
	if (modelId === GEMMA_MODEL.modelId) return new GemmaProvider(options);
	throw new Error(
		`no embedding provider implements model_id "${modelId}" (pinned in .cortex/config); ` +
			`available: ${GEMMA_MODEL.modelId}`,
	);
}

function daemonDisabled(): boolean {
	return process.env.CORTEX_NO_DAEMON === "1";
}
