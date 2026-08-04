import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDecision } from "@tests/support/seed";
import type { CreateDecisionInput } from "@/domain";
import type { EmbeddingProvider } from "@/embedding/provider";
import { EmbedQueue } from "@/embedding/queue";
import { openDecisionsDb } from "@/storage/connection";
import { EmbeddingRepository } from "@/storage/embedding-repository";
import { migrate } from "@/storage/migrations";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";

const context: SaveContext = {
	projectId: "project-1",
	sessionId: "session-1",
	commitSha: "sha-1",
	commitDirty: false,
};

const input: CreateDecisionInput = {
	title: "Adotar JWT para autenticação",
	body: "Usamos JWTs de curta duração assinados com RS256 para a API.",
	keywords: ["autenticação", "authentication", "jwt", "login", "token"],
};

const workingProvider: EmbeddingProvider = {
	modelId: "fake-model@4",
	embedQuery: () => Promise.resolve(Float32Array.from([1, 0, 0, 0])),
	embedPassages: (texts) =>
		Promise.resolve(texts.map(() => Float32Array.from([0.5, 0.5, 0.5, 0.5]))),
};

const brokenProvider: EmbeddingProvider = {
	modelId: "broken-model@4",
	embedQuery: () => Promise.reject(new Error("worker unavailable")),
	embedPassages: () => Promise.reject(new Error("worker unavailable")),
};

let dir: string;
let db: Database;
let nodes: NodeRepository;
let embeddings: EmbeddingRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-queue-"));
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
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("EmbedQueue", () => {
	test("embeds enqueued decisions and stores vector with the provider's model_id", async () => {
		const queue = new EmbedQueue({
			nodes,
			embeddings,
			provider: workingProvider,
		});
		const decision = seedDecision(dir, db, input, context);

		expect(embeddings.listMissingNodeIds("fake-model@4")).toEqual([
			decision.id,
		]);
		queue.enqueue(decision.id);
		await queue.onIdle();

		expect(embeddings.getByNodeId(decision.id)).toEqual({
			nodeId: decision.id,
			modelId: "fake-model@4",
			dims: 4,
			vector: Float32Array.from([0.5, 0.5, 0.5, 0.5]),
		});
		expect(embeddings.listMissingNodeIds("fake-model@4")).toEqual([]);
	});

	test("a broken provider leaves the decision pending without losing the save", async () => {
		const queue = new EmbedQueue({
			nodes,
			embeddings,
			provider: brokenProvider,
		});
		const decision = seedDecision(dir, db, input, context);

		queue.enqueue(decision.id);
		await queue.onIdle();

		expect(embeddings.getByNodeId(decision.id)).toBeNull();
		expect(embeddings.listMissingNodeIds("broken-model@4")).toEqual([
			decision.id,
		]);
		expect(nodes.getById(decision.id)?.title).toBe(input.title);
	});

	test("a failure does not break subsequent enqueues", async () => {
		let calls = 0;
		const flakyProvider: EmbeddingProvider = {
			modelId: "flaky-model@4",
			embedQuery: workingProvider.embedQuery,
			embedPassages: (texts) => {
				calls++;
				if (calls === 1) return Promise.reject(new Error("first call fails"));
				return workingProvider.embedPassages(texts);
			},
		};
		const queue = new EmbedQueue({
			nodes,
			embeddings,
			provider: flakyProvider,
		});
		const first = seedDecision(dir, db, input, context);
		const second = seedDecision(dir, db, input, context);

		queue.enqueue(first.id);
		queue.enqueue(second.id);
		await queue.onIdle();

		expect(embeddings.getByNodeId(first.id)).toBeNull();
		expect(embeddings.getByNodeId(second.id)?.modelId).toBe("flaky-model@4");
	});

	test("a hung provider times out, is disposed and leaves the item pending", async () => {
		let disposed = false;
		const hungProvider: EmbeddingProvider = {
			modelId: "hung-model@4",
			embedQuery: () => new Promise(() => {}),
			embedPassages: () => new Promise(() => {}),
			dispose: () => {
				disposed = true;
			},
		};
		const queue = new EmbedQueue(
			{ nodes, embeddings, provider: hungProvider },
			{ timeoutMs: 50 },
		);
		const decision = seedDecision(dir, db, input, context);

		queue.enqueue(decision.id);
		await queue.onIdle();

		expect(disposed).toBe(true);
		expect(embeddings.getByNodeId(decision.id)).toBeNull();
		expect(embeddings.listMissingNodeIds("hung-model@4")).toEqual([
			decision.id,
		]);
	});

	test("ignores ids that no longer resolve to a decision", async () => {
		const queue = new EmbedQueue({
			nodes,
			embeddings,
			provider: workingProvider,
		});
		queue.enqueue("01890000-0000-7000-8000-000000000000");
		await queue.onIdle();
		expect(db.query("SELECT count(*) AS n FROM embeddings").get()).toEqual({
			n: 0,
		});
	});
});
