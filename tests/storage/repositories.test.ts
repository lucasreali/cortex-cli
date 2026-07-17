import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateDecisionInput } from "@/domain";
import { openDecisionsDb } from "@/storage/connection";
import { EdgeRepository } from "@/storage/edge-repository";
import { migrate } from "@/storage/migrations";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";
import { SearchRepository } from "@/storage/search-repository";

const PROJECT_ID = "project-1";
const SESSION_ID = "session-1";

const context: SaveContext = {
	projectId: PROJECT_ID,
	sessionId: SESSION_ID,
	commitSha: "sha-1",
	commitDirty: false,
};

let dir: string;
let db: Database;
let nodes: NodeRepository;
let edges: EdgeRepository;
let search: SearchRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-repositories-"));
	db = openDecisionsDb(dir);
	migrate(db);
	db.query(
		"INSERT INTO nodes (id, kind, title) VALUES (?, 'project', 'github.com/acme/app')",
	).run(PROJECT_ID);
	db.query("INSERT INTO nodes (id, kind) VALUES (?, 'session')").run(
		SESSION_ID,
	);
	nodes = new NodeRepository(db);
	edges = new EdgeRepository(db);
	search = new SearchRepository(db);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function decisionInput(
	overrides: Partial<CreateDecisionInput> = {},
): CreateDecisionInput {
	return {
		title: "Adotar JWT para autenticação",
		body: "Usamos JWTs de curta duração assinados com RS256 para a API.",
		keywords: ["autenticação", "authentication", "jwt", "login", "token"],
		...overrides,
	};
}

function edgeRows(kind: string): Array<{ from_id: string; to_id: string }> {
	return db
		.query<{ from_id: string; to_id: string }, [string]>(
			"SELECT from_id, to_id FROM edges WHERE kind = ?",
		)
		.all(kind);
}

describe("NodeRepository.createDecision", () => {
	test("persists node, anchors, edges and FTS row", () => {
		const dependency = nodes.createDecision(decisionInput(), context);
		const decision = nodes.createDecision(
			decisionInput({
				title: "Refresh tokens em cookie httpOnly",
				body: "Refresh tokens ficam em cookie httpOnly para mitigar XSS.",
				module: "auth",
				anchors: [
					{ file_path: "src/auth/service.ts", symbol: "AuthService.login" },
					{ file_path: "src/auth/jwt.ts" },
				],
				depends_on: [dependency.id],
			}),
			context,
		);

		expect(nodes.getById(decision.id)).toEqual({
			id: decision.id,
			title: "Refresh tokens em cookie httpOnly",
			body: "Refresh tokens ficam em cookie httpOnly para mitigar XSS.",
			keywords: ["autenticação", "authentication", "jwt", "login", "token"],
			module: "auth",
			status: "active",
			commitSha: "sha-1",
			commitDirty: false,
			provenance: "agent",
			props: null,
			createdAt: expect.any(String),
			anchors: [
				{ filePath: "src/auth/jwt.ts", symbol: "" },
				{ filePath: "src/auth/service.ts", symbol: "AuthService.login" },
			],
		});
		expect(edgeRows("BELONGS_TO")).toContainEqual({
			from_id: decision.id,
			to_id: PROJECT_ID,
		});
		expect(edgeRows("GENERATED_IN")).toContainEqual({
			from_id: decision.id,
			to_id: SESSION_ID,
		});
		expect(edgeRows("DEPENDS_ON")).toEqual([
			{ from_id: decision.id, to_id: dependency.id },
		]);
		expect(db.query("SELECT count(*) AS n FROM nodes_fts").get()).toEqual({
			n: 2,
		});
	});

	test("rolls back everything when an edge target does not exist", () => {
		const input = decisionInput({
			depends_on: ["01890000-0000-7000-8000-000000000000"],
		});
		expect(() => nodes.createDecision(input, context)).toThrow();
		const counts = db
			.query(
				`SELECT
					(SELECT count(*) FROM nodes WHERE kind = 'decision') AS decisions,
					(SELECT count(*) FROM anchors) AS anchors,
					(SELECT count(*) FROM nodes_fts) AS fts`,
			)
			.get();
		expect(counts).toEqual({ decisions: 0, anchors: 0, fts: 0 });
	});
});

describe("EdgeRepository.getImpact", () => {
	test("walks DEPENDS_ON chains in both directions", () => {
		const a = nodes.createDecision(decisionInput(), context);
		const b = nodes.createDecision(
			decisionInput({ depends_on: [a.id] }),
			context,
		);
		const c = nodes.createDecision(
			decisionInput({ depends_on: [b.id] }),
			context,
		);

		expect(edges.getImpact(a.id, 5)).toEqual([
			{ nodeId: b.id, depth: 1 },
			{ nodeId: c.id, depth: 2 },
		]);
		expect(edges.getImpact(c.id, 5)).toEqual([
			{ nodeId: b.id, depth: 1 },
			{ nodeId: a.id, depth: 2 },
		]);
	});

	test("respects maxDepth", () => {
		const a = nodes.createDecision(decisionInput(), context);
		const b = nodes.createDecision(
			decisionInput({ depends_on: [a.id] }),
			context,
		);
		nodes.createDecision(decisionInput({ depends_on: [b.id] }), context);

		expect(edges.getImpact(a.id, 1)).toEqual([{ nodeId: b.id, depth: 1 }]);
	});
});

describe("NodeRepository.replaceDecision", () => {
	test("hides the old decision from listActive but keeps getById", () => {
		const old = nodes.createDecision(decisionInput(), context);
		const replacement = nodes.replaceDecision(
			old.id,
			decisionInput({ title: "Migrar de JWT para sessões opacas" }),
			context,
		);

		const activeIds = nodes.listActive().map((decision) => decision.id);
		expect(activeIds).toEqual([replacement.id]);
		expect(nodes.getById(old.id)?.status).toBe("replaced");
		expect(edgeRows("REPLACED_BY")).toEqual([
			{ from_id: old.id, to_id: replacement.id },
		]);
	});

	test("throws when the replaced decision does not exist", () => {
		expect(() =>
			nodes.replaceDecision("missing-id", decisionInput(), context),
		).toThrow("Decision not found: missing-id");
	});
});

describe("NodeRepository.listActive filters", () => {
	test("filters by module", () => {
		nodes.createDecision(decisionInput({ module: "auth" }), context);
		const billing = nodes.createDecision(
			decisionInput({ module: "billing" }),
			context,
		);

		const active = nodes.listActive({ module: "billing" });
		expect(active.map((decision) => decision.id)).toEqual([billing.id]);
	});

	test("filters by since_sha", () => {
		nodes.createDecision(decisionInput(), { ...context, commitSha: "sha-1" });
		const second = nodes.createDecision(decisionInput(), {
			...context,
			commitSha: "sha-2",
		});
		const third = nodes.createDecision(decisionInput(), {
			...context,
			commitSha: "sha-3",
		});

		const since = nodes.listActive({ sinceSha: "sha-2" });
		expect(since.map((decision) => decision.id)).toEqual([third.id, second.id]);
		expect(nodes.listActive({ sinceSha: "unknown-sha" })).toEqual([]);
	});
});

describe("NodeRepository.listModules", () => {
	test("returns distinct modules sorted", () => {
		nodes.createDecision(decisionInput({ module: "billing" }), context);
		nodes.createDecision(decisionInput({ module: "auth" }), context);
		nodes.createDecision(decisionInput({ module: "auth" }), context);
		nodes.createDecision(decisionInput(), context);

		expect(nodes.listModules()).toEqual(["auth", "billing"]);
	});
});

describe("SearchRepository.searchExact", () => {
	test("matches accented content from unaccented terms", () => {
		const decision = nodes.createDecision(decisionInput(), context);
		const hits = search.searchExact(["decisao", "autenticacao"]);
		expect(hits.map((hit) => hit.nodeId)).toEqual([decision.id]);
	});

	test("matches keywords and reports a bm25 rank", () => {
		const decision = nodes.createDecision(decisionInput(), context);
		nodes.createDecision(
			decisionInput({
				title: "Padronizar logging estruturado",
				body: "Logs em JSON com correlação por request id em toda a API.",
				keywords: ["logging", "logs", "observabilidade", "json", "pino"],
			}),
			context,
		);

		const hits = search.searchExact(["jwt"]);
		expect(hits).toEqual([{ nodeId: decision.id, rank: expect.any(Number) }]);
	});

	test("returns empty for no terms", () => {
		expect(search.searchExact([])).toEqual([]);
	});
});
