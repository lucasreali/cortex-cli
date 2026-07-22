import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingProvider } from "@/embedding/provider";
import { SemanticSearch } from "@/embedding/semantic-search";
import { openDecisionsDb } from "@/storage/connection";
import { EmbeddingRepository } from "@/storage/embedding-repository";
import { migrate } from "@/storage/migrations";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";
import { SearchRepository } from "@/storage/search-repository";
import {
	buildStrategies,
	type SearchStrategy,
	type StrategyStore,
} from "./strategies";

const context: SaveContext = {
	projectId: "project-1",
	sessionId: "session-1",
	commitSha: null,
	commitDirty: false,
};

const QUERY_VECTORS: Record<string, [number, number]> = {
	"cursor pagination question": [1, 0],
	"redis cache lookup": [0.9, 0.435],
};

const provider: EmbeddingProvider = {
	modelId: "fake-model",
	embedQuery: async (text) => vectorFor(text),
	embedPassages: async (texts) => texts.map(vectorFor),
};

function vectorFor(text: string): Float32Array {
	const vector = QUERY_VECTORS[text];
	if (!vector) throw new Error(`no fake vector for query "${text}"`);
	return Float32Array.from(vector);
}

let dir: string;
let db: Database;
let store: StrategyStore;
let pagination: string;
let auth: string;
let redis: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-eval-strategies-"));
	db = openDecisionsDb(dir);
	migrate(db);
	db.query(
		"INSERT INTO nodes (id, kind) VALUES ('project-1', 'project')",
	).run();
	db.query(
		"INSERT INTO nodes (id, kind) VALUES ('session-1', 'session')",
	).run();
	const nodes = new NodeRepository(db);
	const fts = new SearchRepository(db);
	const embeddings = new EmbeddingRepository(db);
	store = {
		nodes,
		fts,
		embeddings,
		semanticSearch: new SemanticSearch({ nodes, embeddings, fts, provider }),
		provider,
	};
	pagination = seedDecision(
		"Paginação por cursor nas listagens",
		["paginação", "pagination", "cursor", "listagem", "api"],
		[1, 0],
	);
	auth = seedDecision(
		"Autenticação stateless com JWT",
		["auth", "jwt", "token", "login", "sessão"],
		[0.8, 0.6],
	);
	redis = seedDecision(
		"Cache de sessões no Redis",
		["cache", "redis", "ttl", "invalidação", "memória"],
		[0, 1],
	);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function seedDecision(
	title: string,
	keywords: string[],
	vector: [number, number],
): string {
	const decision = store.nodes.createDecision(
		{
			title,
			body: "Corpo suficientemente longo para o schema de decisão passar.",
			keywords,
		},
		context,
	);
	store.embeddings.upsert(
		decision.id,
		provider.modelId,
		Float32Array.from(vector),
	);
	return decision.id;
}

function strategy(name: string): SearchStrategy {
	const found = buildStrategies(store).find((entry) => entry.name === name);
	if (!found) throw new Error(`unknown strategy ${name}`);
	return found;
}

describe("current strategy", () => {
	test("delegates to the production SemanticSearch ranking with its threshold", async () => {
		const ranked = await strategy("current").run(
			"cursor pagination question",
			5,
		);
		expect(ranked).toEqual([pagination, auth]);
	});
});

describe("fts strategy", () => {
	test("ranks by bm25 over the query terms", async () => {
		const ranked = await strategy("fts").run("redis cache lookup", 5);
		expect(ranked).toEqual([redis]);
	});

	test("drops replaced decisions from the ranking", async () => {
		store.nodes.replaceDecision(
			redis,
			{
				title: "Armazenamento em memória local",
				body: "Corpo suficientemente longo para o schema de decisão passar.",
				keywords: ["memoria", "local", "lru", "processo", "heap"],
			},
			context,
		);

		const ranked = await strategy("fts").run("redis cache lookup", 5);

		expect(ranked).toEqual([]);
	});
});

describe("vector strategy", () => {
	test("ranks every embedded decision by cosine and honors topK", async () => {
		const ranked = await strategy("vector").run(
			"cursor pagination question",
			2,
		);
		expect(ranked).toEqual([pagination, auth]);
	});
});

describe("current strategy under fusion", () => {
	test("a keyword-exact match climbs over vector-only neighbors", async () => {
		const ranked = await strategy("current").run("redis cache lookup", 5);
		expect(ranked[0]).toBe(redis);
	});
});
