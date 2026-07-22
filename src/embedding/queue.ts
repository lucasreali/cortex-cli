import type { Decision } from "@/domain";
import type { EmbeddingRepository } from "@/storage/embedding-repository";
import type { NodeRepository } from "@/storage/node-repository";
import type { EmbeddingProvider } from "./provider";
import { withTimeout } from "./with-timeout";

export interface EmbedQueueDependencies {
	nodes: NodeRepository;
	embeddings: EmbeddingRepository;
	provider: EmbeddingProvider;
	onEmbedded?(nodeId: string): void;
}

export interface EmbedQueueOptions {
	timeoutMs?: number;
}

const DEFAULT_EMBED_TIMEOUT_MS = 30_000;

export class EmbedQueue {
	private tail: Promise<void> = Promise.resolve();

	constructor(
		private readonly dependencies: EmbedQueueDependencies,
		private readonly options: EmbedQueueOptions = {},
	) {}

	enqueue(nodeId: string): void {
		this.tail = this.tail
			.then(() => this.embedNode(nodeId))
			.catch((error) => {
				console.error(
					`[cortex] embedding for ${nodeId} left pending:`,
					error instanceof Error ? error.message : error,
				);
			});
	}

	async onIdle(): Promise<void> {
		await this.tail;
	}

	private async embedNode(nodeId: string): Promise<void> {
		const decision = this.dependencies.nodes.getById(nodeId);
		if (!decision) return;
		const { provider, embeddings } = this.dependencies;
		const [vector] = await this.embedWithTimeout(decisionPassage(decision));
		if (!vector) throw new Error("provider returned no vector");
		embeddings.upsert(nodeId, provider.modelId, vector);
		this.dependencies.onEmbedded?.(nodeId);
	}

	// A hung worker must never wedge the queue: on timeout the provider is
	// disposed (killing the subprocess) and the item stays pending for
	// `cortex embed --missing`.
	private embedWithTimeout(passage: string): Promise<Float32Array[]> {
		const { provider } = this.dependencies;
		const timeoutMs = this.options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
		return withTimeout(provider.embedPassages([passage]), timeoutMs, () =>
			provider.dispose?.(),
		);
	}
}

export function decisionPassage(decision: Decision): string {
	return `${decision.title}\n${decision.body}`;
}
