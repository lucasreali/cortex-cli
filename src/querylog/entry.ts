import { parseJsonOrNull } from "@/support/json";

export type QuerySurface = "get_context" | "search";

// What was asked, before anything came back. Both query surfaces reduce to this
// one shape so the log has a single row type: an intent is a query with no
// terms, a term search is a query whose text is the terms joined.
export interface AskedQuery {
	surface: QuerySurface;
	query: string;
	terms: string[];
	exact: boolean;
	module: string | null;
}

export interface QueryLogEntry extends AskedQuery {
	session: string;
	at: string;
	results: number;
	ids: string[];
}

export function contextQuery(
	intent: string,
	module: string | null,
): AskedQuery {
	return {
		surface: "get_context",
		query: intent,
		terms: [],
		exact: false,
		module,
	};
}

export function searchQuery(terms: string[], exact: boolean): AskedQuery {
	return {
		surface: "search",
		query: terms.join(" "),
		terms,
		exact,
		module: null,
	};
}

export function encodeEntry(entry: QueryLogEntry): string {
	return `${JSON.stringify(entry)}\n`;
}

// A malformed line is dropped, never the file: the lines around it are still
// the traffic this machine recorded.
export function decodeEntries(text: string): QueryLogEntry[] {
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => parseJsonOrNull<QueryLogEntry>(line))
		.filter(isEntry);
}

function isEntry(value: QueryLogEntry | null): value is QueryLogEntry {
	if (value === null) return false;
	return (
		typeof value.session === "string" &&
		typeof value.query === "string" &&
		(value.surface === "get_context" || value.surface === "search") &&
		Array.isArray(value.terms) &&
		Array.isArray(value.ids) &&
		typeof value.results === "number" &&
		typeof value.at === "string" &&
		!Number.isNaN(Date.parse(value.at))
	);
}
