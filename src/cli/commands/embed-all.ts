import type { CortexRuntime } from "@/app/runtime";
import { failure, style, success } from "@/cli/style";
import type { Decision } from "@/domain";
import type { EmbeddingProvider } from "@/embedding/provider";
import { DEFAULT_EMBED_TIMEOUT_MS, decisionPassage } from "@/embedding/queue";
import { withTimeout } from "@/embedding/with-timeout";

export type EmbedDependencies = Pick<
	CortexRuntime,
	"nodes" | "embeddings" | "provider"
>;

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
	let done = 0;
	for (const nodeId of nodeIds) {
		const decision = runtime.nodes.getById(nodeId);
		if (!decision) continue;
		const vector = await embedDecision(provider, decision, timeoutMs);
		if (!vector) {
			console.error(failure(`no vector returned for ${nodeId}`));
			return 1;
		}
		runtime.embeddings.upsert(nodeId, provider.modelId, vector);
		done++;
		console.log(
			`${style.dim(`[${done}/${nodeIds.length}]`)} ${decision.title}`,
		);
	}
	console.log(success(`Embedded ${done} decision(s).`));
	return 0;
}

// Same discipline as EmbedQueue: a hung worker must never wedge the command,
// so a timeout disposes the provider (killing the subprocess) and fails the
// run with the decision left pending.
async function embedDecision(
	provider: EmbeddingProvider,
	decision: Decision,
	timeoutMs: number,
): Promise<Float32Array | null> {
	try {
		const [vector] = await withTimeout(
			provider.embedPassages([decisionPassage(decision)]),
			timeoutMs,
			() => provider.dispose?.(),
		);
		return vector ?? null;
	} catch (error) {
		console.error(
			failure(error instanceof Error ? error.message : String(error)),
		);
		return null;
	}
}
