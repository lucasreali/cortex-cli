import type { Database } from "bun:sqlite";

export interface SearchHit {
	nodeId: string;
	rank: number;
}

export class SearchRepository {
	constructor(private readonly db: Database) {}

	searchExact(terms: string[], limit = 20): SearchHit[] {
		if (terms.length === 0) return [];
		return this.db
			.query<{ node_id: string; rank: number }, [string, number]>(
				`SELECT node_id, bm25(nodes_fts) AS rank
				 FROM nodes_fts
				 WHERE nodes_fts MATCH ?
				 ORDER BY rank
				 LIMIT ?`,
			)
			.all(toMatchExpression(terms), limit)
			.map((row) => ({ nodeId: row.node_id, rank: row.rank }));
	}
}

function toMatchExpression(terms: string[]): string {
	return terms.map(quote).join(" OR ");
}

function quote(term: string): string {
	return `"${term.replaceAll('"', '""')}"`;
}
