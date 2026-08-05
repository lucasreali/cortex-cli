import type { Database } from "bun:sqlite";
import getImpactSql from "./queries/get-impact.sql" with { type: "text" };

export interface ImpactedNode {
	nodeId: string;
	depth: number;
}

const IMPACT_ROW_LIMIT = 5000;

export class EdgeRepository {
	constructor(private readonly db: Database) {}

	// A conflict is declared on one side but binds both, so partners are
	// collected from either endpoint. Partners that are replaced, archived or
	// off-branch are resolved conflicts and stay out.
	listConflictPartners(ids: string[]): Map<string, string[]> {
		if (ids.length === 0) return new Map();
		const rows = this.db
			.query<{ decision_id: string; partner_id: string }, [string, string]>(
				`SELECT e.from_id AS decision_id, e.to_id AS partner_id
				 FROM edges e
				 JOIN nodes partner ON partner.id = e.to_id
				 WHERE e.kind = 'CONFLICTS_WITH'
				   AND partner.status = 'active' AND partner.present = 1
				   AND e.from_id IN (SELECT value FROM json_each(?))
				 UNION
				 SELECT e.to_id AS decision_id, e.from_id AS partner_id
				 FROM edges e
				 JOIN nodes partner ON partner.id = e.from_id
				 WHERE e.kind = 'CONFLICTS_WITH'
				   AND partner.status = 'active' AND partner.present = 1
				   AND e.to_id IN (SELECT value FROM json_each(?))
				 ORDER BY decision_id, partner_id`,
			)
			.all(JSON.stringify(ids), JSON.stringify(ids));
		return groupPartners(rows);
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

function groupPartners(
	rows: Array<{ decision_id: string; partner_id: string }>,
): Map<string, string[]> {
	const partners = new Map<string, string[]>();
	for (const row of rows) {
		partners.set(row.decision_id, [
			...(partners.get(row.decision_id) ?? []),
			row.partner_id,
		]);
	}
	return partners;
}
