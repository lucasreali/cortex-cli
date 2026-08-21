import type { Decision } from "@/domain";
import type { EmbeddingRepository } from "@/storage/embedding-repository";
import type { NodeRepository } from "@/storage/node-repository";
import { errorMessage } from "@/support/errors";
import { embedDeadlineMs } from "./model-cache";
import type { EmbeddingProvider } from "./provider";
import { disposingOnTimeout } from "./with-timeout";

export interface EmbedQueueDependencies {
	nodes: NodeRepository;
	embeddings: EmbeddingRepository;
	provider: EmbeddingProvider;
	onEmbedded?(nodeId: string): void;
}

export interface EmbedQueueOptions {
	timeoutMs?: number;
}

export const DEFAULT_EMBED_TIMEOUT_MS = 30_000;

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
					errorMessage(error),
				);
			});
	}

	// The tail is re-read after every await: a save that lands while the queue
	// is draining appends to it, and returning on the snapshot taken at call
	// time would drop exactly the vector a shutdown drain exists to keep.
	async onIdle(): Promise<void> {
		let drained: Promise<void> | null = null;
		while (drained !== this.tail) {
			drained = this.tail;
			await drained;
		}
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

	// A timed-out item stays pending for `cortex embed --missing`.
	private embedWithTimeout(passage: string): Promise<Float32Array[]> {
		const { provider } = this.dependencies;
		return disposingOnTimeout(
			provider,
			provider.embedPassages([passage]),
			embedDeadlineMs(
				provider,
				this.options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS,
			),
		);
	}
}

export function decisionPassage(decision: Decision): string {
	return `${decision.title}\n${decision.body}`;
}
