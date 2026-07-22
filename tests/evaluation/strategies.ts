import type { EmbeddingProvider } from "@/embedding/provider";
import {
	dot,
	intentTerms,
	type SemanticSearch,
} from "@/embedding/semantic-search";
import type { EmbeddingRepository } from "@/storage/embedding-repository";
import type { NodeRepository } from "@/storage/node-repository";
import type { SearchRepository } from "@/storage/search-repository";

export interface StrategyStore {
	nodes: NodeRepository;
	fts: SearchRepository;
	embeddings: EmbeddingRepository;
	semanticSearch: SemanticSearch;
	provider: EmbeddingProvider;
}

export interface SearchStrategy {
	name: string;
	run(query: string, topK: number): Promise<string[]>;
}

const BM25_OVERSCAN = 4;

export function buildStrategies(store: StrategyStore): SearchStrategy[] {
	return [
		{ name: "current", run: (query) => currentRanking(store, query) },
		{ name: "fts", run: (query, topK) => bm25Only(store, query, topK) },
		{ name: "vector", run: (query, topK) => vectorOnly(store, query, topK) },
	];
}

async function currentRanking(
	store: StrategyStore,
	query: string,
): Promise<string[]> {
	const results = await store.semanticSearch.search(query);
	return results.map((result) => result.node.id);
}

function bm25Only(
	store: StrategyStore,
	query: string,
	topK: number,
): Promise<string[]> {
	return Promise.resolve(
		bm25Ranking(store, query, topK * BM25_OVERSCAN).slice(0, topK),
	);
}

async function vectorOnly(
	store: StrategyStore,
	query: string,
	topK: number,
): Promise<string[]> {
	const queryVector = await store.provider.embedQuery(query);
	return cosineRanking(store, queryVector).slice(0, topK);
}

function bm25Ranking(
	store: StrategyStore,
	query: string,
	limit: number,
): string[] {
	return store.fts
		.searchExact(intentTerms(query), limit)
		.filter((hit) => isActiveDecision(store.nodes, hit.nodeId))
		.map((hit) => hit.nodeId);
}

function cosineRanking(
	store: StrategyStore,
	queryVector: Float32Array,
): string[] {
	return store.embeddings
		.listActiveVectors(store.provider.modelId)
		.map((entry) => ({
			nodeId: entry.nodeId,
			score: dot(queryVector, entry.vector),
		}))
		.sort((left, right) => right.score - left.score)
		.map((entry) => entry.nodeId);
}

function isActiveDecision(nodes: NodeRepository, nodeId: string): boolean {
	return nodes.getById(nodeId)?.status === "active";
}
