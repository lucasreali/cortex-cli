import type {
	QueryVector,
	SemanticSearchResult,
} from "@/embedding/semantic-search";
import type { CortexRuntime } from "./runtime";

export type SearchDependencies = Pick<
	CortexRuntime,
	"nodes" | "fts" | "semanticSearch"
>;

export interface DecisionQuery {
	terms: string[];
	exact: boolean;
	vector: QueryVector | null;
}

export async function searchDecisions(
	runtime: SearchDependencies,
	terms: string[],
	exact: boolean,
): Promise<SemanticSearchResult[]> {
	if (exact) return exactSearch(runtime, terms);
	return runtime.semanticSearch.search(terms.join(" "));
}

// The same search with the query already embedded, so a fan-out over many
// stores pays for one embedding instead of one per store — and stays
// synchronous, which is what lets a store be opened, read and closed without
// an await holding its handle open.
export function findDecisions(
	runtime: SearchDependencies,
	query: DecisionQuery,
): SemanticSearchResult[] {
	if (query.exact) return exactSearch(runtime, query.terms);
	return runtime.semanticSearch.rank(query.terms.join(" "), query.vector);
}

function exactSearch(
	runtime: SearchDependencies,
	terms: string[],
): SemanticSearchResult[] {
	return runtime.fts.searchExact(terms).flatMap((hit) => {
		const node = runtime.nodes.getById(hit.nodeId);
		return node ? [{ node, score: -hit.rank, source: "fts" as const }] : [];
	});
}
