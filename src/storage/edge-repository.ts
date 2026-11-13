import type { Database } from "bun:sqlite";
import getImpactSql from "./queries/get-impact.sql" with { type: "text" };

export type ImpactRelation = "dependent" | "dependency";

export interface ImpactedNode {
	nodeId: string;
	depth: number;
	relation: ImpactRelation;
}

const IMPACT_ROW_LIMIT = 5000;

export interface VersionedLinks {
	dependsOn: string[];
	replaces: string[];
	replacedBy: string[];
	archives: string[];
	archivedBy: string[];
}

function emptyLinks(): VersionedLinks {
	return {
		dependsOn: [],
		replaces: [],
		replacedBy: [],
		archives: [],
		archivedBy: [],
	};
}

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

	// The versioned links around each decision, from both ends: what it builds
	// on and what it retired, and who retired it. One query for the whole page.
	listVersionedLinks(ids: string[]): Map<string, VersionedLinks> {
		const links = new Map<string, VersionedLinks>(
			ids.map((id) => [id, emptyLinks()]),
		);
		if (ids.length === 0) return links;
		const rows = this.db
			.query<
				{ from_id: string; kind: string; to_id: string },
				[string, string]
			>(
				`SELECT from_id, kind, to_id FROM edges
				 WHERE kind IN ('DEPENDS_ON', 'REPLACED_BY', 'ARCHIVED_BY')
				   AND (from_id IN (SELECT value FROM json_each(?))
				        OR to_id IN (SELECT value FROM json_each(?)))
				 ORDER BY from_id, kind, to_id`,
			)
			.all(JSON.stringify(ids), JSON.stringify(ids));
		for (const row of rows) {
			const from = links.get(row.from_id);
			const to = links.get(row.to_id);
			if (row.kind === "DEPENDS_ON") from?.dependsOn.push(row.to_id);
			if (row.kind === "REPLACED_BY") {
				from?.replacedBy.push(row.to_id);
				to?.replaces.push(row.from_id);
			}
			if (row.kind === "ARCHIVED_BY") {
				from?.archivedBy.push(row.to_id);
				to?.archives.push(row.from_id);
			}
		}
		return links;
	}

	getImpact(decisionId: string, maxDepth = 3): ImpactedNode[] {
		return this.db
			.query<
				{ node_id: string; depth: number; relation: ImpactRelation },
				{ $id: string; $maxDepth: number; $limit: number }
			>(getImpactSql)
			.all({
				$id: decisionId,
				$maxDepth: maxDepth,
				$limit: IMPACT_ROW_LIMIT,
			})
			.map((row) => ({
				nodeId: row.node_id,
				depth: row.depth,
				relation: row.relation,
			}));
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
