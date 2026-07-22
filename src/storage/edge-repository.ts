import type { Database } from "bun:sqlite";
import getImpactSql from "./queries/get-impact.sql" with { type: "text" };

export interface ImpactedNode {
	nodeId: string;
	depth: number;
}

const IMPACT_ROW_LIMIT = 5000;

export class EdgeRepository {
	constructor(private readonly db: Database) {}

	dependsOnIds(decisionId: string): string[] {
		return this.db
			.query<{ to_id: string }, [string]>(
				`SELECT to_id FROM edges
				 WHERE from_id = ? AND kind = 'DEPENDS_ON' ORDER BY to_id`,
			)
			.all(decisionId)
			.map((row) => row.to_id);
	}

	replacedSourceOf(decisionId: string): string | null {
		const row = this.db
			.query<{ from_id: string }, [string]>(
				"SELECT from_id FROM edges WHERE to_id = ? AND kind = 'REPLACED_BY'",
			)
			.get(decisionId);
		return row?.from_id ?? null;
	}

	getImpact(decisionId: string, maxDepth = 3): ImpactedNode[] {
		return this.db
			.query<
				{ node_id: string; depth: number },
				{ $id: string; $maxDepth: number; $limit: number }
			>(getImpactSql)
			.all({
				$id: decisionId,
				$maxDepth: maxDepth,
				$limit: IMPACT_ROW_LIMIT,
			})
			.map((row) => ({ nodeId: row.node_id, depth: row.depth }));
	}
}
