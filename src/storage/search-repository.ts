import type { Database } from "bun:sqlite";

export interface SearchHit {
	nodeId: string;
	rank: number;
}

export type SearchColumn = "title" | "keywords";

export class SearchRepository {
	constructor(private readonly db: Database) {}

	searchExact(terms: string[], limit = 20): SearchHit[] {
		const expression = toMatchExpression(terms);
		if (expression === "") return [];
		return this.match(expression, limit);
	}

	searchColumn(column: SearchColumn, terms: string[], limit = 20): SearchHit[] {
		const expression = toMatchExpression(terms);
		if (expression === "") return [];
		return this.match(`${column} : (${expression})`, limit);
	}

	// nodes_fts is insert-only (neither replacing a decision nor checking out a
	// branch without it touches the index), so the join is what hides replaced
	// and off-branch decisions from every consumer.
	private match(expression: string, limit: number): SearchHit[] {
		return this.db
			.query<{ node_id: string; rank: number }, [string, number]>(
				`SELECT node_id, bm25(nodes_fts) AS rank
				 FROM nodes_fts
				 JOIN nodes ON nodes.id = nodes_fts.node_id
				 WHERE nodes_fts MATCH ?
				   AND nodes.status = 'active' AND nodes.present = 1
				 ORDER BY rank
				 LIMIT ?`,
			)
			.all(expression, limit)
			.map((row) => ({ nodeId: row.node_id, rank: row.rank }));
	}
}

function toMatchExpression(terms: string[]): string {
	return terms
		.map(withoutNul)
		.filter((term) => term.length > 0)
		.map(quote)
		.join(" OR ");
}

// SQLite receives the MATCH expression as a C string, so an embedded NUL
// truncates it mid-quote and the query dies with "unterminated string" instead
// of simply not matching. Every other character quoting handles.
function withoutNul(term: string): string {
	return term.replaceAll("\u0000", "");
}

function quote(term: string): string {
	return `"${term.replaceAll('"', '""')}"`;
}
