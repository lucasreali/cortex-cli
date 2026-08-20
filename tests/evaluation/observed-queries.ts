import { type ObservedQuery, observedQueries } from "@/querylog/fixtures";
import { QueryLog } from "@/querylog/query-log";
import { QueryLogSettings } from "@/querylog/settings";

// The bridge from real traffic to evaluation input: on a machine that opted
// into the query log, these are the questions actually asked of this store,
// deduplicated and ordered by how often they came up. They are candidates for
// GROUND_TRUTH, never a replacement for it — `returned` is what the ranking
// answered, which is the thing a case is written to judge.
export function observedCases(cortexDir: string): ObservedQuery[] {
	return observedQueries(
		new QueryLog(QueryLogSettings.from(cortexDir)).entries(),
	);
}

// Where a hand-written case is most likely missing: a question that came back
// empty is either a decision nobody recorded or a ranking that failed.
export function unansweredCases(cortexDir: string): ObservedQuery[] {
	return observedCases(cortexDir).filter(
		(observed) => observed.returned.length === 0,
	);
}
