import type { Database } from "bun:sqlite";
import { type Anchor, type DecisionFile, parseAnchorText } from "@/domain";
import exportDecisions from "./queries/export-decisions.sql" with {
	type: "text",
};

// The edges a decision file carries. BELONGS_TO and GENERATED_IN point at
// project and session nodes, which are per-machine, so they are never derived
// from a file.
export type VersionedEdgeKind =
	| "DEPENDS_ON"
	| "REPLACED_BY"
	| "CONFLICTS_WITH"
	| "ARCHIVED_BY";

// Where the decision was authored. A decision imported from someone else's
// branch has none: that session never happened on this machine.
export interface LocalLinks {
	projectId: string;
	sessionId: string;
}

export interface DecisionPresence {
	id: string;
	present: boolean;
	contentSha: string | null;
}

export interface OwnedEdge {
	from: string;
	kind: VersionedEdgeKind;
	to: string;
}

interface ExportRow {
	id: string;
	title: string;
	body: string;
	keywords: string;
	module: string | null;
	replaces: string | null;
	archives: string | null;
	depends_on: string;
	conflicts_with: string;
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
			.query<{ id: string; present: number; content_sha: string | null }, []>(
				`SELECT id, present, content_sha FROM nodes
				 WHERE kind = 'decision' ORDER BY id`,
			)
			.all()
			.map((row) => ({
				id: row.id,
				present: row.present === 1,
				contentSha: row.content_sha,
			}));
	}

	// The five writes are one fact, and the invariant lives here rather than in
	// the callers because no caller can restore it: a node row that lost its FTS
	// row is invisible to every search and to prompt-hook, and the reconciler
	// only ever inserts ids it has never seen, so no pass — `--full` included —
	// will ever add the missing one back. Nested inside the reconcile's
	// transaction this is a savepoint, which is what lets one refused decision
	// roll back alone.
	insertDecision(
		file: DecisionFile,
		local: LocalLinks | null,
		contentSha: string | null = null,
	): void {
		this.transaction(() => {
			this.insertNode(file, contentSha);
			this.insertAnchors(file.id, file.anchors);
			this.insertFtsRow(file);
			if (!local) return;
			this.insertLocalEdge(file.id, "BELONGS_TO", local.projectId);
			this.insertLocalEdge(file.id, "GENERATED_IN", local.sessionId);
		});
	}

	// A file whose bytes changed under an id this store already holds. The row,
	// its anchors and its FTS entry are rewritten from the file; the vector is
	// dropped only when the text it was computed from moved, so a fix to an
	// anchor or a keyword does not cost a model load. Status, presence and the
	// local edges are left alone — the first two are derived by the reconcile
	// that called this, the last are facts about this machine.
	updateDecision(file: DecisionFile, contentSha: string): void {
		this.transaction(() => {
			const before = this.db
				.query<{ title: string; body: string }, [string]>(
					"SELECT title, body FROM nodes WHERE id = ?",
				)
				.get(file.id);
			this.db
				.query(
					`UPDATE nodes SET title = ?, body = ?, keywords = ?, module = ?,
						commit_sha = ?, commit_dirty = ?, provenance = ?, created_at = ?,
						content_sha = ?
					 WHERE id = ?`,
				)
				.run(
					file.title,
					file.body,
					JSON.stringify(file.keywords),
					file.module,
					file.commitSha,
					file.commitDirty ? 1 : 0,
					file.provenance,
					file.createdAt,
					contentSha,
					file.id,
				);
			this.db.query("DELETE FROM anchors WHERE node_id = ?").run(file.id);
			this.insertAnchors(file.id, file.anchors);
			this.db.query("DELETE FROM nodes_fts WHERE node_id = ?").run(file.id);
			this.insertFtsRow(file);
			if (before?.title !== file.title || before?.body !== file.body) {
				this.db.query("DELETE FROM embeddings WHERE node_id = ?").run(file.id);
			}
		});
	}

	// The versioned edges a file contributes, read back from the last pass that
	// could parse it: its own DEPENDS_ON and CONFLICTS_WITH, and the retirement
	// edges pointing at it. A present file that stopped parsing — a conflict
	// marker left by a merge — keeps them, because dropping them would hand the
	// decision it replaced back to search as active, next to its successor.
	listEdgesOwnedBy(ids: string[]): OwnedEdge[] {
		if (ids.length === 0) return [];
		return this.db
			.query<
				{ from_id: string; kind: VersionedEdgeKind; to_id: string },
				[string, string]
			>(
				`SELECT from_id, kind, to_id FROM edges
				 WHERE (kind IN ('DEPENDS_ON', 'CONFLICTS_WITH')
				        AND from_id IN (SELECT value FROM json_each(?)))
				    OR (kind IN ('REPLACED_BY', 'ARCHIVED_BY')
				        AND to_id IN (SELECT value FROM json_each(?)))
				 ORDER BY from_id, kind, to_id`,
			)
			.all(JSON.stringify(ids), JSON.stringify(ids))
			.map((row) => ({ from: row.from_id, kind: row.kind, to: row.to_id }));
	}

	setContentSha(id: string, contentSha: string): void {
		this.db
			.query("UPDATE nodes SET content_sha = ? WHERE id = ?")
			.run(contentSha, id);
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
			.query(
				`DELETE FROM edges
				 WHERE kind IN
					('DEPENDS_ON', 'REPLACED_BY', 'CONFLICTS_WITH', 'ARCHIVED_BY')`,
			)
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

	// A decision both superseded and archived (two files, merged branches) comes
	// out 'replaced': a successor exists, which is strictly more information.
	applyStatuses(replacedIds: string[], archivedIds: string[]): void {
		this.db
			.query(
				`UPDATE nodes
				 SET status = CASE
					WHEN id IN (SELECT value FROM json_each(?)) THEN 'replaced'
					WHEN id IN (SELECT value FROM json_each(?)) THEN 'archived'
					ELSE 'active'
				 END
				 WHERE kind = 'decision'`,
			)
			.run(JSON.stringify(replacedIds), JSON.stringify(archivedIds));
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

	private insertNode(file: DecisionFile, contentSha: string | null): void {
		this.db
			.query(
				`INSERT INTO nodes
					(id, kind, title, body, keywords, module, status, present,
					 commit_sha, commit_dirty, provenance, created_at, content_sha)
				 VALUES (?, 'decision', ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?)`,
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
				contentSha,
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
		archives: row.archives,
		dependsOn: JSON.parse(row.depends_on),
		conflictsWith: JSON.parse(row.conflicts_with),
		anchors: JSON.parse(row.anchors).map(parseAnchorText),
		commitSha: row.commit_sha,
		commitDirty: row.commit_dirty === 1,
		provenance: row.provenance,
		createdAt: row.created_at,
	};
}
