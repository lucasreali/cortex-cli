import type { Database } from "bun:sqlite";
import type { Anchor, DecisionFile } from "@/domain";
import exportDecisions from "./queries/export-decisions.sql" with {
	type: "text",
};

// The edges a decision file carries. The other two kinds point at project and
// session nodes, which are per-machine, so they are never derived from a file.
export type VersionedEdgeKind = "DEPENDS_ON" | "REPLACED_BY";

// Where the decision was authored. A decision imported from someone else's
// branch has none: that session never happened on this machine.
export interface LocalLinks {
	projectId: string;
	sessionId: string;
}

export interface DecisionPresence {
	id: string;
	present: boolean;
}

interface ExportRow {
	id: string;
	title: string;
	body: string;
	keywords: string;
	module: string | null;
	replaces: string | null;
	depends_on: string;
	anchors: string;
	commit_sha: string | null;
	commit_dirty: number;
	provenance: DecisionFile["provenance"];
	created_at: string;
}

// The write half of the decision store, kept apart from NodeRepository because
// only the reconciler may touch it: every method here is a step of deriving
// SQLite from the files, never a product operation.
export class DecisionSyncRepository {
	constructor(private readonly db: Database) {}

	transaction<T>(body: () => T): T {
		return this.db.transaction(body)();
	}

	listPresence(): DecisionPresence[] {
		return this.db
			.query<{ id: string; present: number }, []>(
				"SELECT id, present FROM nodes WHERE kind = 'decision' ORDER BY id",
			)
			.all()
			.map((row) => ({ id: row.id, present: row.present === 1 }));
	}

	insertDecision(file: DecisionFile, local: LocalLinks | null): void {
		this.insertNode(file);
		this.insertAnchors(file.id, file.anchors);
		this.insertFtsRow(file);
		if (!local) return;
		this.insertLocalEdge(file.id, "BELONGS_TO", local.projectId);
		this.insertLocalEdge(file.id, "GENERATED_IN", local.sessionId);
	}

	setPresent(ids: string[], present: boolean): void {
		if (ids.length === 0) return;
		this.db
			.query(
				`UPDATE nodes SET present = ?
				 WHERE id IN (SELECT value FROM json_each(?))`,
			)
			.run(present ? 1 : 0, JSON.stringify(ids));
	}

	clearVersionedEdges(): void {
		this.db
			.query("DELETE FROM edges WHERE kind IN ('DEPENDS_ON', 'REPLACED_BY')")
			.run();
	}

	// INSERT OR IGNORE because one file may name the same dependency twice, and
	// two branches may legitimately supersede the same decision.
	insertVersionedEdge(
		fromId: string,
		kind: VersionedEdgeKind,
		toId: string,
	): void {
		this.db
			.query(
				"INSERT OR IGNORE INTO edges (from_id, to_id, kind) VALUES (?, ?, ?)",
			)
			.run(fromId, toId, kind);
	}

	applyStatuses(replacedIds: string[]): void {
		this.db
			.query(
				`UPDATE nodes
				 SET status = CASE
					WHEN id IN (SELECT value FROM json_each(?)) THEN 'replaced'
					ELSE 'active'
				 END
				 WHERE kind = 'decision'`,
			)
			.run(JSON.stringify(replacedIds));
	}

	listExportRows(): DecisionFile[] {
		return this.db.query<ExportRow, []>(exportDecisions).all().map(toRecord);
	}

	listAbsent(): Array<{ id: string; title: string }> {
		return this.db
			.query<{ id: string; title: string }, []>(
				`SELECT id, title FROM nodes
				 WHERE kind = 'decision' AND present = 0
				 ORDER BY id`,
			)
			.all();
	}

	private insertNode(file: DecisionFile): void {
		this.db
			.query(
				`INSERT INTO nodes
					(id, kind, title, body, keywords, module, status, present,
					 commit_sha, commit_dirty, provenance, created_at)
				 VALUES (?, 'decision', ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
			)
			.run(
				file.id,
				file.title,
				file.body,
				JSON.stringify(file.keywords),
				file.module,
				file.commitSha,
				file.commitDirty ? 1 : 0,
				file.provenance,
				file.createdAt,
			);
	}

	private insertAnchors(nodeId: string, anchors: Anchor[]): void {
		const statement = this.db.query(
			"INSERT INTO anchors (node_id, file_path, symbol) VALUES (?, ?, ?)",
		);
		for (const anchor of anchors) {
			statement.run(nodeId, anchor.filePath, anchor.symbol);
		}
	}

	private insertFtsRow(file: DecisionFile): void {
		this.db
			.query(
				"INSERT INTO nodes_fts (node_id, title, body, keywords) VALUES (?, ?, ?, ?)",
			)
			.run(file.id, file.title, file.body, file.keywords.join(" "));
	}

	// Local edges are a fact about this machine, so a duplicate is a bug rather
	// than the branch state converging — no OR IGNORE here on purpose.
	private insertLocalEdge(fromId: string, kind: string, toId: string): void {
		this.db
			.query("INSERT INTO edges (from_id, to_id, kind) VALUES (?, ?, ?)")
			.run(fromId, toId, kind);
	}
}

function toRecord(row: ExportRow): DecisionFile {
	return {
		id: row.id,
		title: row.title,
		body: row.body,
		keywords: JSON.parse(row.keywords),
		module: row.module,
		replaces: row.replaces,
		dependsOn: JSON.parse(row.depends_on),
		anchors: JSON.parse(row.anchors).map(toAnchor),
		commitSha: row.commit_sha,
		commitDirty: row.commit_dirty === 1,
		provenance: row.provenance,
		createdAt: row.created_at,
	};
}

function toAnchor(entry: string): Anchor {
	const hash = entry.lastIndexOf("#");
	if (hash === -1) return { filePath: entry, symbol: "" };
	return { filePath: entry.slice(0, hash), symbol: entry.slice(hash + 1) };
}
