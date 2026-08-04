import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDecision } from "@tests/support/seed";
import { GemmaProvider } from "@/embedding/gemma-provider";
import { EmbedQueue } from "@/embedding/queue";
import { openDecisionsDb } from "@/storage/connection";
import { EmbeddingRepository } from "@/storage/embedding-repository";
import { migrate } from "@/storage/migrations";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";

const modelTest = process.env.RUN_MODEL_TESTS === "1" ? test : test.skip;
const TIMEOUT = 900_000;

function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	for (let index = 0; index < a.length; index++) {
		dot += (a[index] as number) * (b[index] as number);
	}
	return dot;
}

function norm(vector: Float32Array): number {
	return Math.sqrt(cosine(vector, vector));
}

describe("GemmaProvider (RUN_MODEL_TESTS=1)", () => {
	let provider: GemmaProvider;

	beforeAll(() => {
		provider = new GemmaProvider();
	});

	afterAll(() => {
		provider?.dispose();
	});

	modelTest(
		"embeds passages and queries into 256 normalized dims",
		async () => {
			const [jwtDoc, cakeDoc] = await provider.embedPassages([
				"optamos por JWT stateless para autenticação de usuários",
				"a receita de bolo de cenoura leva três ovos e cobertura de chocolate",
			]);
			const query = await provider.embedQuery("como autenticamos usuários?");

			for (const vector of [jwtDoc, cakeDoc, query]) {
				expect(vector).toBeInstanceOf(Float32Array);
				expect(vector?.length).toBe(256);
				expect(norm(vector as Float32Array)).toBeCloseTo(1, 3);
			}
			expect(cosine(query, jwtDoc as Float32Array)).toBeGreaterThan(
				cosine(query, cakeDoc as Float32Array),
			);
		},
		TIMEOUT,
	);

	modelTest(
		"save → queue → embeddings row with the active model_id",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "cortex-gemma-e2e-"));
			let db: Database | null = null;
			try {
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
				const queue = new EmbedQueue({ nodes, embeddings, provider });
				const context: SaveContext = {
					projectId: "project-1",
					sessionId: "session-1",
					commitSha: "sha-1",
					commitDirty: false,
				};

				const decision = seedDecision(
					dir,
					db,
					{
						title: "Adotar JWT para autenticação",
						body: "Usamos JWTs de curta duração assinados com RS256 para a API.",
						keywords: [
							"autenticação",
							"authentication",
							"jwt",
							"login",
							"token",
						],
					},
					context,
				);
				queue.enqueue(decision.id);
				await queue.onIdle();

				const stored = embeddings.getByNodeId(decision.id);
				expect(stored?.modelId).toBe("embeddinggemma-300m-q8@256");
				expect(stored?.dims).toBe(256);
				expect(norm(stored?.vector as Float32Array)).toBeCloseTo(1, 3);
			} finally {
				db?.close();
				rmSync(dir, { recursive: true, force: true });
			}
		},
		TIMEOUT,
	);

	modelTest(
		"idle-kill stops the worker and a later call respawns it",
		async () => {
			const shortIdle = new GemmaProvider({ idleTimeoutMs: 400 });
			try {
				await shortIdle.embedQuery("primeira chamada");
				expect(shortIdle.workerRunning).toBe(true);

				await Bun.sleep(900);
				expect(shortIdle.workerRunning).toBe(false);

				const vector = await shortIdle.embedQuery("segunda chamada");
				expect(vector.length).toBe(256);
				expect(shortIdle.workerRunning).toBe(true);
			} finally {
				shortIdle.dispose();
			}
		},
		TIMEOUT,
	);
});
