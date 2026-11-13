import type { CortexRuntime } from "@/app/runtime";
import { failure, style, success } from "@/cli/style";
import type { Decision } from "@/domain";
import { embedDeadlineMs } from "@/embedding/model-cache";
import type { EmbeddingProvider } from "@/embedding/provider";
import { DEFAULT_EMBED_TIMEOUT_MS, decisionPassage } from "@/embedding/queue";
import { disposingOnTimeout } from "@/embedding/with-timeout";
import { errorMessage } from "@/support/errors";

export type EmbedDependencies = Pick<
	CortexRuntime,
	"nodes" | "embeddings" | "provider"
>;

// One request per batch, not per decision: a request is a round trip through
// the worker's queue, and at ~1 s each a large backlog was minutes of overhead.
export const EMBED_BATCH_SIZE = 8;

// A failure costs the decisions it touched, never the ones after it: a single
// timeout used to abandon the whole backlog without a vector, so the next run
// started over from the same place. A failed batch is retried one decision at
// a time, which isolates the one that cannot be embedded from its neighbours.
export async function embedAll(
	runtime: EmbedDependencies,
	nodeIds: string[],
	timeoutMs: number = DEFAULT_EMBED_TIMEOUT_MS,
): Promise<number> {
	const { provider } = runtime;
	if (!provider) {
		console.error(
			failure(
				"Embeddings are disabled (CORTEX_DISABLE_EMBEDDINGS=1); cannot embed.",
			),
		);
		return 1;
	}
	const decisions = nodeIds.flatMap((id) => runtime.nodes.getById(id) ?? []);
	const progress: Progress = { done: 0, failed: [], total: nodeIds.length };
	for (let start = 0; start < decisions.length; start += EMBED_BATCH_SIZE) {
		const batch = decisions.slice(start, start + EMBED_BATCH_SIZE);
		const vectors = await embedBatch(provider, batch, timeoutMs);
		if (vectors) {
			for (const [index, decision] of batch.entries()) {
				store(runtime, provider, decision, vectors[index] ?? null, progress);
			}
			continue;
		}
		for (const decision of batch) {
			const retried =
				batch.length > 1
					? await embedBatch(provider, [decision], timeoutMs)
					: null;
			store(runtime, provider, decision, retried?.[0] ?? null, progress);
		}
	}
	console.log(success(`Embedded ${progress.done} decision(s).`));
	if (progress.failed.length === 0) return 0;
	console.error(
		failure(
			`${progress.failed.length} decision(s) could not be embedded; ` +
				"run cortex embed --missing again to retry them.",
		),
	);
	return 1;
}

interface Progress {
	done: number;
	failed: string[];
	total: number;
}

function store(
	runtime: EmbedDependencies,
	provider: EmbeddingProvider,
	decision: Decision,
	vector: Float32Array | null,
	progress: Progress,
): void {
	if (!vector) {
		console.error(failure(`no vector returned for ${decision.id}`));
		progress.failed.push(decision.id);
		return;
	}
	runtime.embeddings.upsert(decision.id, provider.modelId, vector);
	progress.done++;
	console.log(
		`${style.dim(`[${progress.done}/${progress.total}]`)} ${decision.title}`,
	);
}

// The deadline grows with the batch: it exists to catch a wedged worker, and a
// worker embedding eight passages is not wedged at the one-passage mark.
async function embedBatch(
	provider: EmbeddingProvider,
	decisions: Decision[],
	timeoutMs: number,
): Promise<Float32Array[] | null> {
	try {
		const vectors = await disposingOnTimeout(
			provider,
			provider.embedPassages(decisions.map(decisionPassage)),
			embedDeadlineMs(provider, timeoutMs * decisions.length),
		);
		return vectors.length === decisions.length ? vectors : null;
	} catch (error) {
		console.error(failure(errorMessage(error)));
		return null;
	}
}
