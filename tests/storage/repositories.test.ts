import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDecision } from "@tests/support/seed";
import type { CreateDecisionInput, Decision } from "@/domain";
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

function create(
	input: CreateDecisionInput,
	saveContext: SaveContext = context,
): Decision {
	return seedDecision(dir, db, input, saveContext);
}

function edgeRows(kind: string): Array<{ from_id: string; to_id: string }> {
	return db
		.query<{ from_id: string; to_id: string }, [string]>(
			"SELECT from_id, to_id FROM edges WHERE kind = ?",
		)
		.all(kind);
}

describe("EdgeRepository.getImpact", () => {
	test("walks DEPENDS_ON chains in both directions", () => {
		const a = create(decisionInput(), context);
		const b = create(decisionInput({ depends_on: [a.id] }), context);
		const c = create(decisionInput({ depends_on: [b.id] }), context);

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
		const a = create(decisionInput(), context);
		const b = create(decisionInput({ depends_on: [a.id] }), context);
		create(decisionInput({ depends_on: [b.id] }), context);

		expect(edges.getImpact(a.id, 1)).toEqual([{ nodeId: b.id, depth: 1 }]);
	});
});

describe("a superseded decision", () => {
	test("leaves listActive but stays reachable by id", () => {
		const old = create(decisionInput(), context);
		const replacement = create(
			decisionInput({
				title: "Migrar de JWT para sessões opacas",
				replaces: old.id,
			}),
			context,
		);

		const activeIds = nodes.listActive().map((decision) => decision.id);
		expect(activeIds).toEqual([replacement.id]);
		expect(nodes.getById(old.id)?.status).toBe("replaced");
		expect(edgeRows("REPLACED_BY")).toEqual([
			{ from_id: old.id, to_id: replacement.id },
		]);
	});
});

describe("NodeRepository.listActive filters", () => {
	test("filters by module", () => {
		create(decisionInput({ module: "auth" }), context);
		const billing = create(decisionInput({ module: "billing" }), context);

		const active = nodes.listActive({ module: "billing" });
		expect(active.map((decision) => decision.id)).toEqual([billing.id]);
	});

	test("filters by since_sha", () => {
		create(decisionInput(), { ...context, commitSha: "sha-1" });
		const second = create(decisionInput(), {
			...context,
			commitSha: "sha-2",
		});
		const third = create(decisionInput(), {
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
		create(decisionInput({ module: "billing" }), context);
		create(decisionInput({ module: "auth" }), context);
		create(decisionInput({ module: "auth" }), context);
		create(decisionInput(), context);

		expect(nodes.listModules()).toEqual(["auth", "billing"]);
	});
});

describe("NodeRepository project and session nodes", () => {
	test("ensureProject is idempotent per canonical id", () => {
		const first = nodes.ensureProject("github.com/acme/app");
		const second = nodes.ensureProject("github.com/acme/app");
		const other = nodes.ensureProject("github.com/acme/other");
		expect(second).toBe(first);
		expect(other).not.toBe(first);
	});

	test("createSession links the session to the project", () => {
		const sessionId = nodes.createSession(PROJECT_ID);
		expect(edgeRows("BELONGS_TO")).toContainEqual({
			from_id: sessionId,
			to_id: PROJECT_ID,
		});
	});

	test("listSessionSummaries returns only sessions with a summary", () => {
		const summarized = nodes.createSession(PROJECT_ID);
		nodes.createSession(PROJECT_ID);
		db.query(
			"UPDATE nodes SET body = 'Refatorada a autenticação.' WHERE id = ?",
		).run(summarized);

		const summaries = nodes.listSessionSummaries(10);
		expect(summaries).toEqual([
			{
				id: summarized,
				summary: "Refatorada a autenticação.",
				createdAt: expect.any(String),
			},
		]);
	});
});

describe("NodeRepository.listByAnchorPath", () => {
	test("matches exact files and directory prefixes, chronologically", () => {
		const first = create(
			decisionInput({ anchors: [{ file_path: "src/auth/service.ts" }] }),
			context,
		);
		const second = create(
			decisionInput({ anchors: [{ file_path: "src/auth/jwt.ts" }] }),
			context,
		);
		create(
			decisionInput({ anchors: [{ file_path: "src/api/login.ts" }] }),
			context,
		);

		const byFile = nodes.listByAnchorPath("src/auth/service.ts");
		expect(byFile.map((decision) => decision.id)).toEqual([first.id]);

		const byDirectory = nodes.listByAnchorPath("src/auth/");
		expect(byDirectory.map((decision) => decision.id)).toEqual([
			first.id,
			second.id,
		]);

		expect(nodes.listByAnchorPath("src/billing")).toEqual([]);
	});
});

describe("NodeRepository.listActiveWithFewKeywords", () => {
	test("flags active decisions below the minimum", () => {
		const deficient = create(
			decisionInput({ keywords: ["jwt", "token", "login"] }),
			context,
		);
		create(decisionInput(), context);

		expect(nodes.listActiveWithFewKeywords(5)).toEqual([
			{ id: deficient.id, title: deficient.title },
		]);
	});
});

describe("SearchRepository.searchExact", () => {
	test("matches accented content from unaccented terms", () => {
		const decision = create(decisionInput(), context);
		const hits = search.searchExact(["decisao", "autenticacao"]);
		expect(hits.map((hit) => hit.nodeId)).toEqual([decision.id]);
	});

	test("matches keywords and reports a bm25 rank", () => {
		const decision = create(decisionInput(), context);
		create(
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

	test("excludes replaced decisions at the source", () => {
		const old = create(decisionInput(), context);
		const replacement = create(
			decisionInput({
				title: "Migrar de JWT para sessões opacas",
				replaces: old.id,
			}),
			context,
		);

		const hits = search.searchExact(["jwt"]);
		expect(hits.map((hit) => hit.nodeId)).toEqual([replacement.id]);
	});
});

describe("NodeRepository.listActiveAnchoredToFiles", () => {
	test("returns active decisions paired with their matching anchor file", () => {
		const anchored = create(
			decisionInput({
				anchors: [
					{ file_path: "src/api/login.ts" },
					{ file_path: "src/api/logout.ts" },
				],
			}),
			context,
		);
		create(
			decisionInput({
				title: "Decisão ancorada em outro lugar qualquer",
				anchors: [{ file_path: "src/billing/invoice.ts" }],
			}),
			context,
		);
		const replaced = create(
			decisionInput({
				title: "Decisão substituída ancorada no login",
				anchors: [{ file_path: "src/api/login.ts" }],
			}),
			context,
		);
		create(
			decisionInput({
				title: "Substituta sem âncoras de arquivo",
				replaces: replaced.id,
			}),
			context,
		);

		const entries = nodes.listActiveAnchoredToFiles([
			"src/api/login.ts",
			"src/api/logout.ts",
		]);

		expect(entries.map((entry) => [entry.decision.id, entry.filePath])).toEqual(
			[
				[anchored.id, "src/api/login.ts"],
				[anchored.id, "src/api/logout.ts"],
			],
		);
	});
});

describe("NodeRepository.listByFileAnchorOrSymbol", () => {
	test("matches file-level anchors and the exact symbol, nothing else", () => {
		const fileLevel = create(
			decisionInput({ anchors: [{ file_path: "src/auth/service.ts" }] }),
			context,
		);
		const exactSymbol = create(
			decisionInput({
				title: "Decisão ancorada no símbolo validateToken",
				anchors: [
					{
						file_path: "src/auth/service.ts",
						symbol: "AuthService.validateToken",
					},
				],
			}),
			context,
		);
		create(
			decisionInput({
				title: "Decisão ancorada em outro símbolo do arquivo",
				anchors: [
					{ file_path: "src/auth/service.ts", symbol: "AuthService.other" },
				],
			}),
			context,
		);

		const decisions = nodes.listByFileAnchorOrSymbol(
			"src/auth/service.ts",
			"AuthService.validateToken",
		);

		expect(decisions.map((decision) => decision.id)).toEqual([
			fileLevel.id,
			exactSymbol.id,
		]);
	});
});

describe("a decision absent from this branch", () => {
	function absentDecision(): string {
		const decision = create(
			decisionInput({
				module: "auth",
				keywords: ["autenticação", "jwt"],
				anchors: [
					{ file_path: "src/auth/service.ts", symbol: "AuthService.login" },
				],
			}),
			context,
		);
		db.query("UPDATE nodes SET present = 0 WHERE id = ?").run(decision.id);
		return decision.id;
	}

	test("disappears from every query that answers 'what governs this code'", () => {
		const id = absentDecision();

		expect(nodes.getById(id)?.present).toBe(false);
		expect(nodes.listActive()).toEqual([]);
		expect(nodes.listModules()).toEqual([]);
		expect(nodes.listByAnchorPath("src/auth/service.ts")).toEqual([]);
		expect(nodes.listActiveAnchoredToFiles(["src/auth/service.ts"])).toEqual(
			[],
		);
		expect(
			nodes.listByFileAnchorOrSymbol(
				"src/auth/service.ts",
				"AuthService.login",
			),
		).toEqual([]);
		expect(nodes.listActiveWithFewKeywords(5)).toEqual([]);
		expect(search.searchExact(["autenticação"])).toEqual([]);
	});

	test("comes back untouched once the file returns", () => {
		const id = absentDecision();
		db.query("UPDATE nodes SET present = 1 WHERE id = ?").run(id);

		expect(nodes.listActive().map((decision) => decision.id)).toEqual([id]);
		expect(
			search.searchExact(["autenticação"]).map((hit) => hit.nodeId),
		).toEqual([id]);
	});
});
