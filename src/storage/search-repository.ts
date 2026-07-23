import type { Database } from "bun:sqlite";

export interface SearchHit {
	nodeId: string;
	rank: number;
}

export type SearchColumn = "title" | "keywords";

export class SearchRepository {
	constructor(private readonly db: Database) {}

	searchExact(terms: string[], limit = 20): SearchHit[] {
		if (terms.length === 0) return [];
		return this.match(toMatchExpression(terms), limit);
	}

	searchColumn(column: SearchColumn, terms: string[], limit = 20): SearchHit[] {
		if (terms.length === 0) return [];
		return this.match(`${column} : (${toMatchExpression(terms)})`, limit);
	}

	// nodes_fts is insert-only (replacing a decision never touches it), so the
	// join is what hides replaced decisions from every consumer of the index.
	private match(expression: string, limit: number): SearchHit[] {
		return this.db
			.query<{ node_id: string; rank: number }, [string, number]>(
				`SELECT node_id, bm25(nodes_fts) AS rank
				 FROM nodes_fts
				 JOIN nodes ON nodes.id = nodes_fts.node_id
				 WHERE nodes_fts MATCH ? AND nodes.status = 'active'
				 ORDER BY rank
				 LIMIT ?`,
			)
			.all(expression, limit)
			.map((row) => ({ nodeId: row.node_id, rank: row.rank }));
	}
}

function toMatchExpression(terms: string[]): string {
	return terms.map(quote).join(" OR ");
}

function quote(term: string): string {
	return `"${term.replaceAll('"', '""')}"`;
}
