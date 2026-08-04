export const NODE_KINDS = ["decision", "session", "project"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
	"BELONGS_TO",
	"GENERATED_IN",
	"DEPENDS_ON",
	"REPLACED_BY",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const NODE_PROVENANCES = ["agent", "human"] as const;
export type NodeProvenance = (typeof NODE_PROVENANCES)[number];

export const IMPORT_PROVENANCES = ["exact", "heuristic"] as const;
export type ImportProvenance = (typeof IMPORT_PROVENANCES)[number];

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
	// Whether this decision's file exists on the branch checked out right now.
	present: boolean;
	commitSha: string | null;
	commitDirty: boolean;
	provenance: NodeProvenance;
	props: Record<string, unknown> | null;
	createdAt: string;
	anchors: Anchor[];
}

export interface Session {
	id: string;
	projectId: string;
	summary: string | null;
	createdAt: string;
}

export interface Project {
	id: string;
	canonicalId: string;
	createdAt: string;
}

export interface IndexedFile {
	path: string;
	lang: string;
	hash: string;
	mtime: number;
	size: number;
}

export interface CodeSymbol {
	name: string;
	kind: string;
	line: number;
}

export interface CodeImport {
	specifier: string;
	toPath: string | null;
	provenance: ImportProvenance;
}

export interface FileIndexEntry {
	file: IndexedFile;
	symbols: CodeSymbol[];
	imports: CodeImport[];
}
