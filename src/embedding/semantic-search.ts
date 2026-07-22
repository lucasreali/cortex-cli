import type { Decision } from "@/domain";
import type { EmbeddingRepository } from "@/storage/embedding-repository";
import type { NodeRepository } from "@/storage/node-repository";
import type { SearchRepository } from "@/storage/search-repository";
import type { EmbeddingProvider } from "./provider";
import { withTimeout } from "./with-timeout";

export interface SemanticSearchResult {
	node: Decision;
	score: number;
	source: "vector" | "fts";
}

export interface SemanticSearchDependencies {
	nodes: NodeRepository;
	embeddings: EmbeddingRepository;
	fts: SearchRepository;
	provider: EmbeddingProvider | null;
}

export interface SemanticSearchOptions {
	topK?: number;
	threshold?: number;
	queryTimeoutMs?: number;
}

const DEFAULT_TOP_K = 5;
const DEFAULT_THRESHOLD = 0.3;
const DEFAULT_QUERY_TIMEOUT_MS = 2000;

export class SemanticSearch {
	private vectorCache: Map<string, Float32Array> | null = null;

	constructor(
		private readonly dependencies: SemanticSearchDependencies,
		private readonly options: SemanticSearchOptions = {},
	) {}

	invalidate(): void {
		this.vectorCache = null;
	}

	async search(intent: string): Promise<SemanticSearchResult[]> {
		const covered = new Set<string>();
		const vectorResults = await this.tryVectorSearch(intent, covered);
		const slots = this.topK() - vectorResults.length;
		if (slots <= 0) return vectorResults;
		return [...vectorResults, ...this.ftsSearch(intent, covered, slots)];
	}

	private async tryVectorSearch(
		intent: string,
		covered: Set<string>,
	): Promise<SemanticSearchResult[]> {
		const { provider } = this.dependencies;
		if (!provider) return [];
		const queryVector = await this.embedIntent(provider, intent);
		if (!queryVector) return [];
		const cache = this.loadCache(provider.modelId);
		for (const nodeId of cache.keys()) {
			covered.add(nodeId);
		}
		return [...cache.entries()]
			.map(([nodeId, vector]) => ({ nodeId, score: dot(queryVector, vector) }))
			.filter((entry) => entry.score >= this.threshold())
			.sort((a, b) => b.score - a.score)
			.slice(0, this.topK())
			.flatMap((entry) => this.toResult(entry.nodeId, entry.score, "vector"));
	}

	private ftsSearch(
		intent: string,
		covered: Set<string>,
		slots: number,
	): SemanticSearchResult[] {
		const terms = intentTerms(intent);
		if (terms.length === 0) return [];
		return this.dependencies.fts
			.searchExact(terms, this.topK() * 4)
			.filter((hit) => !covered.has(hit.nodeId))
			.flatMap((hit) => this.toResult(hit.nodeId, -hit.rank, "fts"))
			.slice(0, slots);
	}

	private toResult(
		nodeId: string,
		score: number,
		source: SemanticSearchResult["source"],
	): SemanticSearchResult[] {
		const node = this.dependencies.nodes.getById(nodeId);
		if (node?.status !== "active") return [];
		return [{ node, score, source }];
	}

	private loadCache(modelId: string): Map<string, Float32Array> {
		this.vectorCache ??= new Map(
			this.dependencies.embeddings
				.listActiveVectors(modelId)
				.map((entry) => [entry.nodeId, entry.vector]),
		);
		return this.vectorCache;
	}

	// The vector path must never block a query: a cold worker (model still
	// loading after an idle-kill) hits the timeout and FTS answers instead,
	// per spec §2.4. The provider keeps loading for the next query.
	private async embedIntent(
		provider: EmbeddingProvider,
		intent: string,
	): Promise<Float32Array | null> {
		const timeoutMs = this.options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
		try {
			return await withTimeout(provider.embedQuery(intent), timeoutMs);
		} catch {
			return null;
		}
	}

	private topK(): number {
		return this.options.topK ?? DEFAULT_TOP_K;
	}

	private threshold(): number {
		return this.options.threshold ?? DEFAULT_THRESHOLD;
	}
}

function dot(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let index = 0; index < a.length; index++) {
		sum += (a[index] as number) * (b[index] as number);
	}
	return sum;
}

function intentTerms(intent: string): string[] {
	return intent
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((term) => term.length >= 3);
}
