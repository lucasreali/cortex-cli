import type { Database } from "bun:sqlite";
import type {
	Anchor,
	Decision,
	DecisionStatus,
	NodeProvenance,
} from "@/domain";
import { symbolKey } from "@/support/symbol-key";
import { likeLiteral } from "./like-pattern";

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
	limit?: number;
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

interface AnchoredRow extends NodeRow {
	anchor_symbol: string;
}

function anchoringSymbol(symbol: string): (row: AnchoredRow) => boolean {
	const wanted = symbolKey(symbol);
	return (row) =>
		row.anchor_symbol === "" || symbolKey(row.anchor_symbol) === wanted;
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
		return this.toDecisions([row])[0] ?? null;
	}

	// A store accumulates decisions forever, so the callers that only want the
	// most recent few say so here rather than slicing what they were handed:
	// SQLite reads `LIMIT -1` as no limit, which keeps the unbounded callers on
	// the same statement.
	listActive(filters: ListActiveFilters = {}): Decision[] {
		const conditions = [
			"kind = 'decision'",
			"status = 'active'",
			"present = 1",
		];
		const params: Array<string | number> = [];
		if (filters.module) {
			conditions.push("module = ?");
			params.push(filters.module);
		}
		if (filters.sinceSha) {
			conditions.push("id >= (SELECT MIN(id) FROM nodes WHERE commit_sha = ?)");
			params.push(filters.sinceSha);
		}
		params.push(filters.limit ?? -1);
		const rows = this.db
			.query<NodeRow, Array<string | number>>(
				`SELECT * FROM nodes WHERE ${conditions.join(" AND ")}
				 ORDER BY id DESC LIMIT ?`,
			)
			.all(...params);
		return this.toDecisions(rows);
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

	// Check-then-insert, so the two halves have to share one write lock: every
	// runtime calls this, and two processes opening the same repository at once
	// would otherwise mint two project nodes for one canonical id, splitting
	// every session's BELONGS_TO edges across two identities. The lookup runs
	// first and unlocked because it answers on all but the very first call.
	ensureProject(canonicalId: string): string {
		return (
			this.findProject(canonicalId) ??
			this.db.transaction(() => this.createProject(canonicalId)).immediate()
		);
	}

	private findProject(canonicalId: string): string | null {
		return (
			this.db
				.query<{ id: string }, [string]>(
					"SELECT id FROM nodes WHERE kind = 'project' AND title = ?",
				)
				.get(canonicalId)?.id ?? null
		);
	}

	private createProject(canonicalId: string): string {
		const existing = this.findProject(canonicalId);
		if (existing) return existing;
		const id = Bun.randomUUIDv7();
		this.db
			.query("INSERT INTO nodes (id, kind, title) VALUES (?, 'project', ?)")
			.run(id, canonicalId);
		return id;
	}

	// The id may be minted before the row exists: the runtime needs a session
	// identity for the local usefulness log from the first read, and a read must
	// not insert a session node to get one.
	createSession(projectNodeId: string, id = Bun.randomUUIDv7()): string {
		return this.db.transaction(() => {
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
		const rows = this.db
			.query<NodeRow, [string, string]>(
				`SELECT DISTINCT n.* FROM nodes n
				 JOIN anchors a ON a.node_id = n.id
				 WHERE n.kind = 'decision' AND n.present = 1
				   AND (a.file_path = ? OR a.file_path LIKE ? || '/%' ESCAPE '\\')
				 ORDER BY n.id ASC`,
			)
			.all(normalized, likeLiteral(normalized));
		return this.toDecisions(rows);
	}

	listActiveAnchoredToFiles(
		paths: string[],
	): Array<{ decision: Decision; filePath: string }> {
		const rows = this.db
			.query<NodeRow & { anchor_path: string }, [string]>(
				`SELECT DISTINCT n.*, a.file_path AS anchor_path
				 FROM nodes n
				 JOIN anchors a ON a.node_id = n.id
				 WHERE n.kind = 'decision' AND n.status = 'active' AND n.present = 1
				   AND a.file_path IN (SELECT value FROM json_each(?))
				 ORDER BY n.id, a.file_path`,
			)
			.all(JSON.stringify(paths));
		const anchors = this.anchorsFor(rows.map((row) => row.id));
		return rows.map((row) => ({
			decision: this.toDecision(row, anchors.get(row.id) ?? []),
			filePath: row.anchor_path,
		}));
	}

	// SQLite cannot run the symbol recipe, and `decisions.db` stores an anchor
	// verbatim, so the file half stays in SQL and every anchor on that file comes
	// back for `symbolKey` to judge here — the alternative, a stored key column,
	// would be a second copy of the recipe free to go stale against it.
	listByFileAnchorOrSymbol(filePath: string, symbol: string): Decision[] {
		const rows = this.db
			.query<AnchoredRow, [string]>(
				`SELECT n.*, a.symbol AS anchor_symbol FROM nodes n
				 JOIN anchors a ON a.node_id = n.id
				 WHERE n.kind = 'decision' AND n.present = 1
				   AND a.file_path = ?
				 ORDER BY n.id ASC`,
			)
			.all(filePath);
		return this.oncePerNode(rows.filter(anchoringSymbol(symbol)));
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

	private oncePerNode(rows: NodeRow[]): Decision[] {
		const oneRowPerNode = new Map(rows.map((row) => [row.id, row]));
		return this.toDecisions([...oneRowPerNode.values()]);
	}

	private insertEdge(fromId: string, kind: string, toId: string): void {
		this.db
			.query("INSERT INTO edges (from_id, to_id, kind) VALUES (?, ?, ?)")
			.run(fromId, toId, kind);
	}

	private toDecisions(rows: NodeRow[]): Decision[] {
		const anchors = this.anchorsFor(rows.map((row) => row.id));
		return rows.map((row) => this.toDecision(row, anchors.get(row.id) ?? []));
	}

	// One query for the whole page instead of one per row: the overview path is
	// the most frequent read there is, and it used to cost a round trip per
	// decision in the store.
	private anchorsFor(nodeIds: string[]): Map<string, Anchor[]> {
		const byNode = new Map<string, Anchor[]>();
		if (nodeIds.length === 0) return byNode;
		const rows = this.db
			.query<{ node_id: string; file_path: string; symbol: string }, [string]>(
				`SELECT node_id, file_path, symbol FROM anchors
				 WHERE node_id IN (SELECT value FROM json_each(?))
				 ORDER BY file_path, symbol`,
			)
			.all(JSON.stringify(nodeIds));
		for (const row of rows) {
			const anchors = byNode.get(row.node_id) ?? [];
			anchors.push({ filePath: row.file_path, symbol: row.symbol });
			byNode.set(row.node_id, anchors);
		}
		return byNode;
	}

	private toDecision(row: NodeRow, anchors: Anchor[]): Decision {
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
			anchors,
		};
	}
}
