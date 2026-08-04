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
const RRF_K = 60;

export interface FusedRanking {
	nodeId: string;
	score: number;
}

export class SemanticSearch {
	private vectorCache: Map<string, Float32Array> | null = null;

	constructor(
		private readonly dependencies: SemanticSearchDependencies,
		private readonly options: SemanticSearchOptions = {},
	) {}

	invalidate(): void {
		this.vectorCache = null;
	}

	// RRF over both legs (measured in tests/evaluation/): the vector leg keeps
	// the relevance threshold so unrelated intents still come back empty, and
	// with no vector available the fusion degrades to plain BM25 top-K.
	async search(intent: string): Promise<SemanticSearchResult[]> {
		const vectorLeg = await this.vectorLeg(intent);
		const inVector = new Set(vectorLeg);
		return fuseRankings([vectorLeg, this.bm25Leg(intent)])
			.slice(0, this.topK())
			.flatMap((entry) =>
				this.toResult(
					entry.nodeId,
					entry.score,
					inVector.has(entry.nodeId) ? "vector" : "fts",
				),
			);
	}

	private async vectorLeg(intent: string): Promise<string[]> {
		const { provider } = this.dependencies;
		if (!provider) return [];
		const queryVector = await this.embedIntent(provider, intent);
		if (!queryVector) return [];
		return [...this.loadCache(provider.modelId).entries()]
			.map(([nodeId, vector]) => ({ nodeId, score: dot(queryVector, vector) }))
			.filter((entry) => entry.score >= this.threshold())
			.sort((a, b) => b.score - a.score)
			.map((entry) => entry.nodeId);
	}

	private bm25Leg(intent: string): string[] {
		const terms = intentTerms(intent);
		if (terms.length === 0) return [];
		return this.dependencies.fts
			.searchExact(terms, this.topK())
			.map((hit) => hit.nodeId);
	}

	// This check guards the vector leg only: the cache can serve a decision
	// replaced or checked out from under it after it was loaded (invalidation
	// happens when the replacement finishes embedding). FTS hits are already
	// filtered by the join.
	private toResult(
		nodeId: string,
		score: number,
		source: SemanticSearchResult["source"],
	): SemanticSearchResult[] {
		const node = this.dependencies.nodes.getById(nodeId);
		if (node?.status !== "active" || !node.present) return [];
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
	// loading after an idle-kill) hits the timeout and FTS answers instead.
	// The provider keeps loading for the next query.
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

export function fuseRankings(rankings: string[][]): FusedRanking[] {
	const scores = new Map<string, number>();
	for (const ranking of rankings) {
		ranking.forEach((nodeId, index) => {
			scores.set(nodeId, (scores.get(nodeId) ?? 0) + 1 / (RRF_K + index + 1));
		});
	}
	return [...scores.entries()]
		.map(([nodeId, score]) => ({ nodeId, score }))
		.sort(
			(left, right) =>
				right.score - left.score || left.nodeId.localeCompare(right.nodeId),
		);
}

export function dot(a: Float32Array, b: Float32Array): number {
	// Mismatched dimensions mean vectors from two embedding spaces reached the
	// same store; scoring them would silently yield NaN instead of failing.
	if (a.length !== b.length) {
		throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
	}
	let sum = 0;
	for (const [index, value] of a.entries()) {
		sum += value * (b[index] as number);
	}
	return sum;
}

export function intentTerms(intent: string): string[] {
	return intent
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((term) => term.length >= 3);
}
