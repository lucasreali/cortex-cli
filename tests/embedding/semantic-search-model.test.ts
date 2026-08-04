import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDecision } from "@tests/support/seed";
import type { CreateDecisionInput } from "@/domain";
import { GemmaProvider } from "@/embedding/gemma-provider";
import { EmbedQueue } from "@/embedding/queue";
import { SemanticSearch } from "@/embedding/semantic-search";
import { openDecisionsDb } from "@/storage/connection";
import { EmbeddingRepository } from "@/storage/embedding-repository";
import { migrate } from "@/storage/migrations";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";
import { SearchRepository } from "@/storage/search-repository";

const modelTest = process.env.RUN_MODEL_TESTS === "1" ? test : test.skip;
const TIMEOUT = 900_000;

// The JWT decision deliberately avoids any "autentica" substring so only
// the semantic path — never FTS on the query terms — can rank it.
const JWT_DECISION: CreateDecisionInput = {
	title: "Adotar JWT stateless com refresh tokens",
	body: "Tokens de acesso expiram em quinze minutos; refresh tokens rotacionados a cada uso ficam em cookie httpOnly.",
	keywords: ["jwt", "token", "login", "sessão", "segurança"],
};

const OTHER_DECISIONS: CreateDecisionInput[] = [
	{
		title: "PostgreSQL como banco principal",
		body: "Escolhemos PostgreSQL como banco de dados principal do projeto.",
		keywords: ["postgres", "banco", "database", "sql", "storage"],
	},
	{
		title: "Migrations automáticas no deploy",
		body: "As migrations do banco rodam automaticamente durante o deploy.",
		keywords: ["migrations", "deploy", "banco", "schema", "automation"],
	},
	{
		title: "Cache de sessões no Redis",
		body: "O cache de sessões fica no Redis com TTL de uma hora.",
		keywords: ["redis", "cache", "sessões", "ttl", "memória"],
	},
	{
		title: "Filas RabbitMQ para emails",
		body: "Usamos filas no RabbitMQ para processar emails em background.",
		keywords: ["rabbitmq", "filas", "emails", "background", "queue"],
	},
	{
		title: "Paginação por cursor na API",
		body: "O frontend consome a API REST paginada com cursor opaco.",
		keywords: ["api", "rest", "paginação", "cursor", "frontend"],
	},
	{
		title: "Logs estruturados no Elasticsearch",
		body: "Logs estruturados em JSON são enviados para o Elasticsearch.",
		keywords: ["logs", "json", "elasticsearch", "observabilidade", "logging"],
	},
	{
		title: "CI com containers efêmeros",
		body: "O CI roda testes de integração contra containers efêmeros.",
		keywords: ["ci", "testes", "containers", "integração", "pipeline"],
	},
	{
		title: "Feature flags via config remota",
		body: "Lançamentos graduais usam feature flags lidas de configuração remota.",
		keywords: ["feature", "flags", "config", "rollout", "release"],
	},
	{
		title: "Monorepo com workspaces do Bun",
		body: "Os pacotes internos vivem num monorepo com workspaces do Bun.",
		keywords: ["monorepo", "workspaces", "bun", "pacotes", "build"],
	},
];

describe("SemanticSearch with Gemma (RUN_MODEL_TESTS=1)", () => {
	let dir: string;
	let db: Database | null = null;
	let provider: GemmaProvider;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "cortex-semantic-model-"));
		provider = new GemmaProvider();
	});

	afterAll(() => {
		provider?.dispose();
		db?.close();
		rmSync(dir, { recursive: true, force: true });
	});

	modelTest(
		"intent query ranks the JWT decision in the top-3 without term overlap",
		async () => {
			db = openDecisionsDb(dir);
			migrate(db);
			db.query(
				"INSERT INTO nodes (id, kind) VALUES ('project-1', 'project')",
			).run();
			db.query(
				"INSERT INTO nodes (id, kind) VALUES ('session-1', 'session')",
			).run();
			const nodes = new NodeRepository(db);
			const embeddings = new EmbeddingRepository(db);
			const fts = new SearchRepository(db);
			const queue = new EmbedQueue({ nodes, embeddings, provider });
			const context: SaveContext = {
				projectId: "project-1",
				sessionId: "session-1",
				commitSha: "sha-1",
				commitDirty: false,
			};

			const serialized = JSON.stringify(JWT_DECISION);
			expect(serialized).not.toContain("autentica");

			const jwtId = seedDecision(dir, db, JWT_DECISION, context).id;
			queue.enqueue(jwtId);
			for (const input of OTHER_DECISIONS) {
				queue.enqueue(seedDecision(dir, db, input, context).id);
			}
			await queue.onIdle();
			expect(embeddings.listMissingNodeIds(provider.modelId)).toEqual([]);

			const search = new SemanticSearch({ nodes, embeddings, fts, provider });
			const results = await search.search("como autenticamos usuários?");

			const topThree = results.slice(0, 3);
			const jwtHit = topThree.find((result) => result.node.id === jwtId);
			expect(jwtHit?.source).toBe("vector");

			const offline = new SemanticSearch({
				nodes,
				embeddings,
				fts,
				provider: null,
			});
			const degraded = await offline.search("jwt");
			expect(degraded.length).toBeGreaterThan(0);
			expect(degraded.every((result) => result.source === "fts")).toBe(true);
		},
		TIMEOUT,
	);
});
