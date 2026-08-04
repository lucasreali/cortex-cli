import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDecision } from "@tests/support/seed";
import { searchDecisions } from "@/app/search-decisions";
import { SemanticSearch } from "@/embedding/semantic-search";
import { openDecisionsDb } from "@/storage/connection";
import { EmbeddingRepository } from "@/storage/embedding-repository";
import { migrate } from "@/storage/migrations";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";
import { SearchRepository } from "@/storage/search-repository";

const context: SaveContext = {
	projectId: "project-1",
	sessionId: "session-1",
	commitSha: null,
	commitDirty: false,
};

let dir: string;
let db: Database;
let nodes: NodeRepository;
let fts: SearchRepository;
let semanticSearch: SemanticSearch;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-search-decisions-"));
	db = openDecisionsDb(dir);
	migrate(db);
	db.query(
		"INSERT INTO nodes (id, kind) VALUES ('project-1', 'project')",
	).run();
	db.query(
		"INSERT INTO nodes (id, kind) VALUES ('session-1', 'session')",
	).run();
	nodes = new NodeRepository(db);
	fts = new SearchRepository(db);
	semanticSearch = new SemanticSearch({
		nodes,
		embeddings: new EmbeddingRepository(db),
		fts,
		provider: null,
	});
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function runtime() {
	return { nodes, fts, semanticSearch };
}

function saveDecision(title: string, keywords: string[]) {
	return seedDecision(
		dir,
		db,
		{
			title,
			body: "Corpo suficientemente longo para o schema de decisão passar.",
			keywords,
		},
		context,
	);
}

describe("searchDecisions", () => {
	test("exact search returns active decisions with fts source and bm25 score", async () => {
		const decision = saveDecision("Autenticação stateless com JWT", [
			"auth",
			"jwt",
			"token",
			"login",
			"sessão",
		]);

		const results = await searchDecisions(runtime(), ["jwt"], true);

		expect(results).toHaveLength(1);
		expect(results[0]?.node.id).toBe(decision.id);
		expect(results[0]?.source).toBe("fts");
		expect(results[0]?.score).toBeGreaterThan(0);
	});

	test("exact search drops replaced decisions", async () => {
		const old = saveDecision("Sessões server-side no Redis", [
			"auth",
			"redis",
			"session",
			"login",
			"cache",
		]);
		seedDecision(
			dir,
			db,
			{
				title: "Autenticação stateless com JWT",
				body: "Corpo suficientemente longo para o schema de decisão passar.",
				keywords: ["auth", "jwt", "token", "login", "sessão"],
				replaces: old.id,
			},
			context,
		);

		const results = await searchDecisions(runtime(), ["redis"], true);

		expect(results).toEqual([]);
	});

	test("non-exact search delegates to semantic search (fts fallback without provider)", async () => {
		const decision = saveDecision("Paginação por cursor nas listagens", [
			"paginação",
			"pagination",
			"cursor",
			"listagem",
			"api",
		]);

		const results = await searchDecisions(runtime(), ["cursor"], false);

		expect(results).toHaveLength(1);
		expect(results[0]?.node.id).toBe(decision.id);
		expect(results[0]?.source).toBe("fts");
	});
});
