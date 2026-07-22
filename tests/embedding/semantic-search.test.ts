import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateDecisionInput } from "@/domain";
import type { EmbeddingProvider } from "@/embedding/provider";
import { EmbedQueue } from "@/embedding/queue";
import { fuseRankings, SemanticSearch } from "@/embedding/semantic-search";
import { openDecisionsDb } from "@/storage/connection";
import { EmbeddingRepository } from "@/storage/embedding-repository";
import { migrate } from "@/storage/migrations";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";
import { SearchRepository } from "@/storage/search-repository";

const context: SaveContext = {
	projectId: "project-1",
	sessionId: "session-1",
	commitSha: "sha-1",
	commitDirty: false,
};

const CONCEPT_AXES: Array<{ axis: number; words: string[] }> = [
	{ axis: 0, words: ["jwt", "autentic", "login", "token"] },
	{ axis: 1, words: ["postgres", "banco", "migrations"] },
	{ axis: 2, words: ["redis", "cache", "sessões"] },
];

function conceptVector(text: string): Float32Array {
	const lowered = text.toLowerCase();
	const vector = new Float32Array(4);
	const matched = CONCEPT_AXES.find((concept) =>
		concept.words.some((word) => lowered.includes(word)),
	);
	vector[matched?.axis ?? 3] = 1;
	return vector;
}

const conceptProvider: EmbeddingProvider = {
	modelId: "concept-model@4",
	embedQuery: (text) => Promise.resolve(conceptVector(text)),
	embedPassages: (texts) => Promise.resolve(texts.map(conceptVector)),
};

const brokenProvider: EmbeddingProvider = {
	modelId: "concept-model@4",
	embedQuery: () => Promise.reject(new Error("worker unavailable")),
	embedPassages: () => Promise.reject(new Error("worker unavailable")),
};

const jwtInput: CreateDecisionInput = {
	title: "Adotar JWT para login",
	body: "Tokens de acesso de curta duração assinados com RS256 para a API.",
	keywords: ["jwt", "login", "token", "sessão", "segurança"],
};

const postgresInput: CreateDecisionInput = {
	title: "PostgreSQL como banco principal",
	body: "Escolhemos PostgreSQL pelo suporte a JSON e às migrations declarativas.",
	keywords: ["postgres", "banco", "database", "sql", "migrations"],
};

let dir: string;
let db: Database;
let nodes: NodeRepository;
let embeddings: EmbeddingRepository;
let fts: SearchRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-semantic-"));
	db = openDecisionsDb(dir);
	migrate(db);
	db.query(
		"INSERT INTO nodes (id, kind) VALUES ('project-1', 'project')",
	).run();
	db.query(
		"INSERT INTO nodes (id, kind) VALUES ('session-1', 'session')",
	).run();
	nodes = new NodeRepository(db);
	embeddings = new EmbeddingRepository(db);
	fts = new SearchRepository(db);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

async function createEmbedded(
	input: CreateDecisionInput,
	provider: EmbeddingProvider,
): Promise<string> {
	const queue = new EmbedQueue({ nodes, embeddings, provider });
	const decision = nodes.createDecision(input, context);
	queue.enqueue(decision.id);
	await queue.onIdle();
	return decision.id;
}

describe("SemanticSearch — vector path", () => {
	test("ranks by cosine above the threshold and tags source vector", async () => {
		const jwtId = await createEmbedded(jwtInput, conceptProvider);
		await createEmbedded(postgresInput, conceptProvider);
		const search = new SemanticSearch({
			nodes,
			embeddings,
			fts,
			provider: conceptProvider,
		});

		const results = await search.search("autenticação de usuários");

		expect(results).toHaveLength(1);
		expect(results[0]?.node.id).toBe(jwtId);
		expect(results[0]?.source).toBe("vector");
		expect(results[0]?.score).toBeCloseTo(1 / 61, 5);
	});

	test("a keyword hit below the vector threshold still surfaces via bm25", async () => {
		const postgresId = await createEmbedded(postgresInput, conceptProvider);
		const search = new SemanticSearch({
			nodes,
			embeddings,
			fts,
			provider: conceptProvider,
		});

		const results = await search.search("login com migrations");

		expect(results.map((result) => [result.node.id, result.source])).toEqual([
			[postgresId, "fts"],
		]);
	});

	test("an unrelated intent returns empty even with vectors present", async () => {
		await createEmbedded(jwtInput, conceptProvider);
		await createEmbedded(postgresInput, conceptProvider);
		const search = new SemanticSearch({
			nodes,
			embeddings,
			fts,
			provider: conceptProvider,
		});

		const results = await search.search("grafana dashboards");

		expect(results).toEqual([]);
	});

	test("merges FTS hits for nodes without vector", async () => {
		const jwtId = await createEmbedded(jwtInput, conceptProvider);
		const pending = nodes.createDecision(
			{
				title: "Dashboards no Grafana",
				body: "Métricas de runtime expostas para painéis de observabilidade.",
				keywords: ["grafana", "dashboards", "metrics", "painel", "monitoring"],
			},
			context,
		);
		const search = new SemanticSearch({
			nodes,
			embeddings,
			fts,
			provider: conceptProvider,
		});

		const results = await search.search("login com jwt e painéis grafana");

		expect(results.map((result) => [result.node.id, result.source])).toEqual([
			[jwtId, "vector"],
			[pending.id, "fts"],
		]);
	});

	test("respects topK", async () => {
		await createEmbedded(jwtInput, conceptProvider);
		await createEmbedded(
			{ ...jwtInput, title: "Refresh token rotacionado" },
			conceptProvider,
		);
		const search = new SemanticSearch(
			{ nodes, embeddings, fts, provider: conceptProvider },
			{ topK: 1 },
		);

		const results = await search.search("jwt");
		expect(results).toHaveLength(1);
	});
});

describe("SemanticSearch — degradation", () => {
	test("a throwing provider degrades to FTS over all nodes without erroring", async () => {
		const jwtId = await createEmbedded(jwtInput, conceptProvider);
		const search = new SemanticSearch({
			nodes,
			embeddings,
			fts,
			provider: brokenProvider,
		});

		const results = await search.search("jwt");

		expect(results.map((result) => [result.node.id, result.source])).toEqual([
			[jwtId, "fts"],
		]);
	});

	test("a cold provider hits the query timeout and FTS answers instead", async () => {
		const jwtId = await createEmbedded(jwtInput, conceptProvider);
		const coldProvider: EmbeddingProvider = {
			modelId: "concept-model@4",
			embedQuery: () => new Promise(() => {}),
			embedPassages: conceptProvider.embedPassages,
		};
		const search = new SemanticSearch(
			{ nodes, embeddings, fts, provider: coldProvider },
			{ queryTimeoutMs: 50 },
		);

		const results = await search.search("jwt");

		expect(results.map((result) => [result.node.id, result.source])).toEqual([
			[jwtId, "fts"],
		]);
	});

	test("a null provider behaves the same", async () => {
		const jwtId = await createEmbedded(jwtInput, conceptProvider);
		const search = new SemanticSearch({
			nodes,
			embeddings,
			fts,
			provider: null,
		});

		const results = await search.search("jwt");

		expect(results.map((result) => [result.node.id, result.source])).toEqual([
			[jwtId, "fts"],
		]);
	});
});

describe("SemanticSearch — cache", () => {
	test("invalidate() picks up embeddings written after the first search", async () => {
		await createEmbedded(postgresInput, conceptProvider);
		const search = new SemanticSearch({
			nodes,
			embeddings,
			fts,
			provider: conceptProvider,
		});
		await search.search("banco de dados");

		const lateId = await createEmbedded(
			{
				title: "Acesso via token opaco",
				body: "Tokens opacos validados por introspecção; login continua stateless.",
				keywords: ["opaco", "introspecção", "acesso", "stateless", "rotação"],
			},
			conceptProvider,
		);

		const stale = await search.search("jwt");
		expect(stale.map((result) => result.node.id)).not.toContain(lateId);

		search.invalidate();
		const fresh = await search.search("jwt");
		expect(fresh.map((result) => result.node.id)).toContain(lateId);
	});

	test("the queue's onEmbedded hook wires invalidation", async () => {
		const search = new SemanticSearch({
			nodes,
			embeddings,
			fts,
			provider: conceptProvider,
		});
		const queue = new EmbedQueue({
			nodes,
			embeddings,
			provider: conceptProvider,
			onEmbedded: () => search.invalidate(),
		});
		await search.search("jwt");

		const decision = nodes.createDecision(jwtInput, context);
		queue.enqueue(decision.id);
		await queue.onIdle();

		const results = await search.search("jwt");
		expect(results.map((result) => result.node.id)).toContain(decision.id);
	});
});

describe("fuseRankings", () => {
	test("an id present in both rankings outscores single-list leaders", () => {
		const fused = fuseRankings([
			["a", "b"],
			["b", "c"],
		]);
		expect(fused.map((entry) => entry.nodeId)).toEqual(["b", "a", "c"]);
	});

	test("ties break lexicographically for determinism", () => {
		const fused = fuseRankings([["b"], ["a"]]);
		expect(fused.map((entry) => entry.nodeId)).toEqual(["a", "b"]);
	});
});

describe("SemanticSearch — replaced decisions", () => {
	test("replaced decisions never surface", async () => {
		const oldId = await createEmbedded(jwtInput, conceptProvider);
		const queue = new EmbedQueue({
			nodes,
			embeddings,
			provider: conceptProvider,
		});
		const replacement = nodes.replaceDecision(
			oldId,
			{ ...jwtInput, title: "JWT com rotação de refresh" },
			context,
		);
		queue.enqueue(replacement.id);
		await queue.onIdle();
		const search = new SemanticSearch({
			nodes,
			embeddings,
			fts,
			provider: conceptProvider,
		});

		const results = await search.search("jwt");

		expect(results.map((result) => result.node.id)).toEqual([replacement.id]);
	});
});
