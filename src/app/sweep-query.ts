import { GEMMA_MODEL } from "@/embedding/model";
import type { EmbeddingProvider } from "@/embedding/provider";
import type { QueryVector } from "@/embedding/semantic-search";
import { readConfig } from "@/storage/config";
import { ProjectRoot } from "@/storage/project-root";
import { withTimeout } from "@/support/with-timeout";

const QUERY_EMBED_TIMEOUT_MS = 2000;

// A sweep embeds its query once and ranks every store against that vector, so
// it needs one model for the whole fan-out: the current project's pinned one,
// because that is the only one this machine is known to be able to load. A
// store pinned to another model holds no vectors under this id and answers
// through FTS, which is the correct degradation, not a failure.
export async function sweepModelId(root: string | null): Promise<string> {
	if (!root) return GEMMA_MODEL.modelId;
	const config = await readConfig(ProjectRoot.at(root).cortexDir);
	return config?.model_id ?? GEMMA_MODEL.modelId;
}

// Like every other query path, the vector leg is bounded and optional: a cold
// worker times out and the sweep answers from FTS alone. The provider is left
// alone so the model it is still loading serves the next query.
export async function embedSweepQuery(
	provider: EmbeddingProvider,
	intent: string,
): Promise<QueryVector | null> {
	try {
		const vector = await withTimeout(
			provider.embedQuery(intent),
			QUERY_EMBED_TIMEOUT_MS,
		);
		return { vector, modelId: provider.modelId };
	} catch {
		return null;
	}
}
