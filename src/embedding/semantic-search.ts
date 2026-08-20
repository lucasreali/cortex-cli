import type { Decision } from "@/domain";
import type { EmbeddingRepository } from "@/storage/embedding-repository";
import type { NodeRepository } from "@/storage/node-repository";
import type { SearchRepository } from "@/storage/search-repository";
import { withTimeout } from "@/support/with-timeout";
import type { UsefulnessRanking } from "@/usefulness/score";
import type { EmbeddingProvider } from "./provider";

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
	usefulness?: UsefulnessRanking | null;
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

// Every surface rounds a score to this before showing it, and the usefulness
// tiebreaker orders exactly the results that round to the same number — so the
// rule it follows is one a reader can check: results the printed score cannot
// tell apart are ordered by what proved useful on this machine.
export const SCORE_PRECISION = 3;

export function displayScore(score: number): number {
	return Number(score.toFixed(SCORE_PRECISION));
}

export interface FusedRanking {
	nodeId: string;
	score: number;
}

// The model id travels with the vector because it is what makes the two
// comparable: ranking a query embedded by one model against vectors written
// by another is meaningless, and across projects the pinned model can differ.
export interface QueryVector {
	vector: Float32Array;
	modelId: string;
}

export class SemanticSearch {
	private cache: VectorCache | null = null;

	constructor(
		private readonly dependencies: SemanticSearchDependencies,
		private readonly options: SemanticSearchOptions = {},
	) {}

	invalidate(): void {
		this.cache = null;
	}

	// RRF over both legs (measured in tests/evaluation/): the vector leg keeps
	// the relevance threshold so unrelated intents still come back empty, and
	// with no vector available the fusion degrades to plain BM25 top-K.
	async search(intent: string): Promise<SemanticSearchResult[]> {
		return this.rank(intent, await this.embedQuery(intent));
	}

	// Split out of search so a cross-project sweep pays the embedding once and
	// ranks every store against the same vector, instead of embedding the
	// identical text once per project behind one serialized worker.
	async embedQuery(intent: string): Promise<QueryVector | null> {
		const { provider } = this.dependencies;
		if (!provider) return null;
		const vector = await this.embedIntent(provider, intent);
		return vector ? { vector, modelId: provider.modelId } : null;
	}

	rank(intent: string, query: QueryVector | null): SemanticSearchResult[] {
		const vectorLeg = this.vectorLeg(query);
		const inVector = new Set(vectorLeg);
		const selected = fuseRankings([vectorLeg, this.bm25Leg(intent)])
			.slice(0, this.topK())
			.flatMap((entry) =>
				this.toResult(
					entry.nodeId,
					entry.score,
					inVector.has(entry.nodeId) ? "vector" : "fts",
				),
			);
		return this.preferUseful(selected);
	}

	// Runs on the already-selected top-K, never on the selection: deleting the
	// sidecar changes the order the agent reads, never which decisions come
	// back. The sort is stable, so results with no signal keep their fused
	// order.
	private preferUseful(
		results: SemanticSearchResult[],
	): SemanticSearchResult[] {
		const usefulness = this.dependencies.usefulness;
		if (!usefulness) return results;
		const scores = usefulness.scores();
		if (scores.size === 0) return results;
		const usefulnessOf = (result: SemanticSearchResult): number =>
			scores.get(result.node.id) ?? 0;
		return [...results].sort(
			(left, right) =>
				displayScore(right.score) - displayScore(left.score) ||
				usefulnessOf(right) - usefulnessOf(left),
		);
	}

	private vectorLeg(query: QueryVector | null): string[] {
		if (!query) return [];
		return [...this.loadCache(query.modelId).vectors.entries()]
			.map(([nodeId, vector]) => ({
				nodeId,
				score: dot(query.vector, vector),
			}))
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

	// Two things make a loaded cache wrong, and neither is visible from inside
	// this process alone. Embedding is deliberately pushed out of process — the
	// git hook spawns `cortex embed --missing`, and the docs tell people to run
	// it by hand — so a cache held by a long-lived MCP server would answer from
	// FTS for the rest of the session and tell the agent those decisions do not
	// match; the store says when another connection wrote, and that is cheaper
	// than re-reading. And the model can change under it now that the query
	// vector may come from outside: a sweep can rank this store against a model
	// it holds no vectors for, and serving the previous model's cache would
	// score across two embedding spaces.
	private loadCache(modelId: string): VectorCache {
		const { embeddings } = this.dependencies;
		const written = embeddings.externalWriteCounter();
		if (!this.cache?.answersFor(modelId, written)) {
			this.cache = VectorCache.load(embeddings, modelId, written);
		}
		return this.cache;
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

interface CacheKey {
	modelId: string;
	writeCounter: number;
}

class VectorCache {
	private constructor(
		private readonly key: CacheKey,
		readonly vectors: Map<string, Float32Array>,
	) {}

	static load(
		embeddings: EmbeddingRepository,
		modelId: string,
		writeCounter: number,
	): VectorCache {
		return new VectorCache(
			{ modelId, writeCounter },
			new Map(
				embeddings
					.listActiveVectors(modelId)
					.map((entry) => [entry.nodeId, entry.vector]),
			),
		);
	}

	answersFor(modelId: string, writeCounter: number): boolean {
		return (
			this.key.modelId === modelId && this.key.writeCounter === writeCounter
		);
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
