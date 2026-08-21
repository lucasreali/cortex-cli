import { sha256Hex } from "@/support/hash";
import type { QueryLogEntry, QuerySurface } from "./entry";

const FIXTURE_ID_LENGTH = 12;

// A logged query is a candidate fixture, never ground truth: what it carries is
// what the ranking returned, which is the very thing an evaluation case exists
// to judge. Confirming a case stays a human act — this only surfaces the real
// traffic worth confirming, and the queries that came back empty first.
export interface ObservedQuery {
	id: string;
	surface: QuerySurface;
	query: string;
	terms: string[];
	exact: boolean;
	returned: string[];
	occurrences: number;
	lastAskedAt: string;
}

export function observedQueries(entries: QueryLogEntry[]): ObservedQuery[] {
	const merged = new Map<string, ObservedQuery>();
	for (const entry of entries) {
		const id = fixtureId(entry);
		merged.set(id, mergedWith(merged.get(id), entry, id));
	}
	return [...merged.values()].sort(byWeightThenRecency);
}

// The same question asked ten times is one fixture asked ten times, and the
// newest run is the one that describes the ranking as it stands today.
function mergedWith(
	seen: ObservedQuery | undefined,
	entry: QueryLogEntry,
	id: string,
): ObservedQuery {
	return {
		id,
		surface: entry.surface,
		query: entry.query,
		terms: entry.terms,
		exact: entry.exact,
		returned: entry.ids,
		occurrences: (seen?.occurrences ?? 0) + 1,
		lastAskedAt: entry.at,
	};
}

function fixtureId(entry: QueryLogEntry): string {
	const identity = `${entry.surface}:${entry.exact}:${entry.query.trim().toLowerCase()}`;
	return sha256Hex(identity).slice(0, FIXTURE_ID_LENGTH);
}

function byWeightThenRecency(
	left: ObservedQuery,
	right: ObservedQuery,
): number {
	if (left.occurrences !== right.occurrences) {
		return right.occurrences - left.occurrences;
	}
	return right.lastAskedAt.localeCompare(left.lastAskedAt);
}
