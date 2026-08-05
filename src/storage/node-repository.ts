import type { Database } from "bun:sqlite";
import type {
	Anchor,
	Decision,
	DecisionStatus,
	NodeProvenance,
} from "@/domain";

export interface SaveContext {
	projectId: string;
	sessionId: string;
	commitSha: string | null;
	commitDirty: boolean;
	provenance?: NodeProvenance;
}

export interface ListActiveFilters {
	module?: string;
	sinceSha?: string;
}

interface NodeRow {
	id: string;
	title: string;
	body: string;
	keywords: string;
	module: string | null;
	status: DecisionStatus;
	present: number;
	commit_sha: string | null;
	commit_dirty: number;
	provenance: NodeProvenance;
	props: string | null;
	created_at: string;
}

export class NodeRepository {
	constructor(private readonly db: Database) {}

	getById(id: string): Decision | null {
		const row = this.db
			.query<NodeRow, [string]>(
				"SELECT * FROM nodes WHERE id = ? AND kind = 'decision'",
			)
			.get(id);
		if (!row) return null;
		return this.toDecision(row);
	}

	listActive(filters: ListActiveFilters = {}): Decision[] {
		const conditions = [
			"kind = 'decision'",
			"status = 'active'",
			"present = 1",
		];
		const params: string[] = [];
		if (filters.module) {
			conditions.push("module = ?");
			params.push(filters.module);
		}
		if (filters.sinceSha) {
			conditions.push("id >= (SELECT MIN(id) FROM nodes WHERE commit_sha = ?)");
			params.push(filters.sinceSha);
		}
		const rows = this.db
			.query<NodeRow, string[]>(
				`SELECT * FROM nodes WHERE ${conditions.join(" AND ")} ORDER BY id DESC`,
			)
			.all(...params);
		return rows.map((row) => this.toDecision(row));
	}

	// listActive's `sinceSha` filter compares against the id of the first
	// decision recorded at that sha, and an unknown sha makes that subquery
	// NULL — which silently matches nothing. Callers ask first so they can say
	// so, which happens naturally whenever a branch is squash-merged and the
	// recorded sha stops existing.
	hasCommitSha(sha: string): boolean {
		return (
			this.db
				.query<{ one: number }, [string]>(
					"SELECT 1 AS one FROM nodes WHERE commit_sha = ? LIMIT 1",
				)
				.get(sha) !== null
		);
	}

	ensureProject(canonicalId: string): string {
		const existing = this.db
			.query<{ id: string }, [string]>(
				"SELECT id FROM nodes WHERE kind = 'project' AND title = ?",
			)
			.get(canonicalId);
		if (existing) return existing.id;
		const id = Bun.randomUUIDv7();
		this.db
			.query("INSERT INTO nodes (id, kind, title) VALUES (?, 'project', ?)")
			.run(id, canonicalId);
		return id;
	}

	createSession(projectNodeId: string): string {
		return this.db.transaction(() => {
			const id = Bun.randomUUIDv7();
			this.db
				.query("INSERT INTO nodes (id, kind) VALUES (?, 'session')")
				.run(id);
			this.insertEdge(id, "BELONGS_TO", projectNodeId);
			return id;
		})();
	}

	updateSessionSummary(sessionId: string, summary: string): void {
		this.db
			.query("UPDATE nodes SET body = ? WHERE id = ? AND kind = 'session'")
			.run(summary, sessionId);
	}

	listSessionSummaries(
		limit: number,
	): Array<{ id: string; summary: string; createdAt: string }> {
		return this.db
			.query<{ id: string; body: string; created_at: string }, [number]>(
				`SELECT id, body, created_at FROM nodes
				 WHERE kind = 'session' AND body IS NOT NULL AND body != ''
				 ORDER BY id DESC LIMIT ?`,
			)
			.all(limit)
			.map((row) => ({
				id: row.id,
				summary: row.body,
				createdAt: row.created_at,
			}));
	}

	listByAnchorPath(path: string): Decision[] {
		const normalized = path.replace(/\/+$/, "");
		return this.db
			.query<NodeRow, [string, string]>(
				`SELECT DISTINCT n.* FROM nodes n
				 JOIN anchors a ON a.node_id = n.id
				 WHERE n.kind = 'decision' AND n.present = 1
				   AND (a.file_path = ? OR a.file_path LIKE ? || '/%')
				 ORDER BY n.id ASC`,
			)
			.all(normalized, normalized)
			.map((row) => this.toDecision(row));
	}

	listActiveAnchoredToFiles(
		paths: string[],
	): Array<{ decision: Decision; filePath: string }> {
		return this.db
			.query<NodeRow & { anchor_path: string }, [string]>(
				`SELECT DISTINCT n.*, a.file_path AS anchor_path
				 FROM nodes n
				 JOIN anchors a ON a.node_id = n.id
				 WHERE n.kind = 'decision' AND n.status = 'active' AND n.present = 1
				   AND a.file_path IN (SELECT value FROM json_each(?))
				 ORDER BY n.id, a.file_path`,
			)
			.all(JSON.stringify(paths))
			.map((row) => ({
				decision: this.toDecision(row),
				filePath: row.anchor_path,
			}));
	}

	listByFileAnchorOrSymbol(filePath: string, symbol: string): Decision[] {
		return this.db
			.query<NodeRow, [string, string]>(
				`SELECT DISTINCT n.* FROM nodes n
				 JOIN anchors a ON a.node_id = n.id
				 WHERE n.kind = 'decision' AND n.present = 1
				   AND a.file_path = ?
				   AND (a.symbol = '' OR a.symbol = ?)
				 ORDER BY n.id ASC`,
			)
			.all(filePath, symbol)
			.map((row) => this.toDecision(row));
	}

	listActiveWithFewKeywords(minimum: number): Array<{
		id: string;
		title: string;
	}> {
		return this.db
			.query<{ id: string; title: string }, [number]>(
				`SELECT id, title FROM nodes
				 WHERE kind = 'decision' AND status = 'active' AND present = 1
				   AND json_array_length(keywords) < ?
				 ORDER BY id`,
			)
			.all(minimum);
	}

	listModules(): string[] {
		return this.db
			.query<{ module: string }, []>(
				`SELECT DISTINCT module FROM nodes
				 WHERE kind = 'decision' AND present = 1 AND module IS NOT NULL
				 ORDER BY module`,
			)
			.all()
			.map((row) => row.module);
	}

	private insertEdge(fromId: string, kind: string, toId: string): void {
		this.db
			.query("INSERT INTO edges (from_id, to_id, kind) VALUES (?, ?, ?)")
			.run(fromId, toId, kind);
	}

	private anchorsOf(nodeId: string): Anchor[] {
		return this.db
			.query<{ file_path: string; symbol: string }, [string]>(
				`SELECT file_path, symbol FROM anchors WHERE node_id = ?
				 ORDER BY file_path, symbol`,
			)
			.all(nodeId)
			.map((row) => ({ filePath: row.file_path, symbol: row.symbol }));
	}

	private toDecision(row: NodeRow): Decision {
		return {
			id: row.id,
			title: row.title,
			body: row.body,
			keywords: JSON.parse(row.keywords),
			module: row.module,
			status: row.status,
			present: row.present === 1,
			commitSha: row.commit_sha,
			commitDirty: row.commit_dirty === 1,
			provenance: row.provenance,
			props: row.props === null ? null : JSON.parse(row.props),
			createdAt: row.created_at,
			anchors: this.anchorsOf(row.id),
		};
	}
}
