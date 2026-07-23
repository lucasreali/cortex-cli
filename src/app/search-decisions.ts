import type { SemanticSearchResult } from "@/embedding/semantic-search";
import type { CortexRuntime } from "./runtime";

type SearchDependencies = Pick<
	CortexRuntime,
	"nodes" | "fts" | "semanticSearch"
>;

export async function searchDecisions(
	runtime: SearchDependencies,
	terms: string[],
	exact: boolean,
): Promise<SemanticSearchResult[]> {
	if (exact) return exactSearch(runtime, terms);
	return runtime.semanticSearch.search(terms.join(" "));
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
