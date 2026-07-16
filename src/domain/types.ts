export const EDGE_KINDS = [
	"BELONGS_TO",
	"GENERATED_IN",
	"DEPENDS_ON",
	"REPLACED_BY",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const PROVENANCES = ["exact", "heuristic"] as const;
export type Provenance = (typeof PROVENANCES)[number];

export const DECISION_STATUSES = ["active", "replaced"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export interface Anchor {
	filePath: string;
	symbol: string;
}

export interface Decision {
	id: string;
	title: string;
	body: string;
	keywords: string[];
	module: string | null;
	status: DecisionStatus;
	commitSha: string | null;
	dirty: boolean;
	createdAt: string;
	anchors: Anchor[];
}

export interface Session {
	id: string;
	projectId: string;
	summary: string | null;
	startedAt: string;
}

export interface Project {
	id: string;
	canonicalId: string;
	createdAt: string;
}
