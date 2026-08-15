import type { QueryLogEntry } from "./entry";

// Recent enough that the answer is about the store as it is now: a miss rate
// over a year of queries would average away the week the index went stale.
export const RECENT_QUERY_WINDOW = 50;

export interface RecentQueries {
	recorded: number;
	considered: number;
	empty: number;
}

export function recentQueries(entries: QueryLogEntry[]): RecentQueries {
	const recent = entries.slice(-RECENT_QUERY_WINDOW);
	return {
		recorded: entries.length,
		considered: recent.length,
		empty: recent.filter((entry) => entry.results === 0).length,
	};
}
