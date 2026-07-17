import type { Database } from "bun:sqlite";
import type {
	Anchor,
	CreateDecisionInput,
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
	commit_sha: string | null;
	commit_dirty: number;
	provenance: NodeProvenance;
	props: string | null;
	created_at: string;
}

export class NodeRepository {
	constructor(private readonly db: Database) {}

	createDecision(input: CreateDecisionInput, context: SaveContext): Decision {
		return this.db.transaction(() => this.insertDecision(input, context))();
	}

	replaceDecision(
		oldId: string,
		input: CreateDecisionInput,
		context: SaveContext,
	): Decision {
		return this.db.transaction(() => {
			this.markReplaced(oldId);
			const decision = this.insertDecision(input, context);
			this.insertEdge(oldId, "REPLACED_BY", decision.id);
			return decision;
		})();
	}

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
		const conditions = ["kind = 'decision'", "status = 'active'"];
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

	listModules(): string[] {
		return this.db
			.query<{ module: string }, []>(
				`SELECT DISTINCT module FROM nodes
				 WHERE kind = 'decision' AND module IS NOT NULL
				 ORDER BY module`,
			)
			.all()
			.map((row) => row.module);
	}

	private insertDecision(
		input: CreateDecisionInput,
		context: SaveContext,
	): Decision {
		const id = Bun.randomUUIDv7();
		this.insertNode(id, input, context);
		this.insertAnchors(id, input.anchors ?? []);
		this.insertEdge(id, "BELONGS_TO", context.projectId);
		this.insertEdge(id, "GENERATED_IN", context.sessionId);
		for (const dependencyId of input.depends_on ?? []) {
			this.insertEdge(id, "DEPENDS_ON", dependencyId);
		}
		this.insertFtsRow(id, input);
		return this.requireById(id);
	}

	private insertNode(
		id: string,
		input: CreateDecisionInput,
		context: SaveContext,
	): void {
		this.db
			.query(
				`INSERT INTO nodes
					(id, kind, title, body, keywords, module, commit_sha, commit_dirty, provenance)
				 VALUES (?, 'decision', ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.title,
				input.body,
				JSON.stringify(input.keywords),
				input.module ?? null,
				context.commitSha,
				context.commitDirty ? 1 : 0,
				context.provenance ?? "agent",
			);
	}

	private insertAnchors(
		nodeId: string,
		anchors: NonNullable<CreateDecisionInput["anchors"]>,
	): void {
		const statement = this.db.query(
			"INSERT INTO anchors (node_id, file_path, symbol) VALUES (?, ?, ?)",
		);
		for (const anchor of anchors) {
			statement.run(nodeId, anchor.file_path, anchor.symbol ?? "");
		}
	}

	private insertEdge(fromId: string, kind: string, toId: string): void {
		this.db
			.query("INSERT INTO edges (from_id, to_id, kind) VALUES (?, ?, ?)")
			.run(fromId, toId, kind);
	}

	private insertFtsRow(id: string, input: CreateDecisionInput): void {
		this.db
			.query(
				"INSERT INTO nodes_fts (node_id, title, body, keywords) VALUES (?, ?, ?, ?)",
			)
			.run(id, input.title, input.body, input.keywords.join(" "));
	}

	private markReplaced(id: string): void {
		const changes = this.db
			.query(
				"UPDATE nodes SET status = 'replaced' WHERE id = ? AND kind = 'decision'",
			)
			.run(id).changes;
		if (changes === 0) throw new Error(`Decision not found: ${id}`);
	}

	private requireById(id: string): Decision {
		const decision = this.getById(id);
		if (!decision) throw new Error(`Decision not found: ${id}`);
		return decision;
	}

	private anchorsOf(nodeId: string): Anchor[] {
		return this.db
			.query<{ file_path: string; symbol: string }, [string]>(
				"SELECT file_path, symbol FROM anchors WHERE node_id = ?",
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
			commitSha: row.commit_sha,
			commitDirty: row.commit_dirty === 1,
			provenance: row.provenance,
			props: row.props === null ? null : JSON.parse(row.props),
			createdAt: row.created_at,
			anchors: this.anchorsOf(row.id),
		};
	}
}
