import type { Database } from "bun:sqlite";
import getImpactSql from "./queries/get-impact.sql" with { type: "text" };

export interface ImpactedNode {
	nodeId: string;
	depth: number;
}

const IMPACT_ROW_LIMIT = 5000;

export class EdgeRepository {
	constructor(private readonly db: Database) {}

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
