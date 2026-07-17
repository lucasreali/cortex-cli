import type { Decision } from "@/domain";
import type { EmbeddingRepository } from "@/storage/embedding-repository";
import type { NodeRepository } from "@/storage/node-repository";
import type { EmbeddingProvider } from "./provider";

export interface EmbedQueueDependencies {
	nodes: NodeRepository;
	embeddings: EmbeddingRepository;
	provider: EmbeddingProvider;
	onEmbedded?(nodeId: string): void;
}

export class EmbedQueue {
	private tail: Promise<void> = Promise.resolve();

	constructor(private readonly dependencies: EmbedQueueDependencies) {}

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
		const [vector] = await provider.embedPassages([decisionPassage(decision)]);
		if (!vector) throw new Error("provider returned no vector");
		embeddings.upsert(nodeId, provider.modelId, vector);
		this.dependencies.onEmbedded?.(nodeId);
	}
}

export function decisionPassage(decision: Decision): string {
	return `${decision.title}\n${decision.body}`;
}
