import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDecision } from "@tests/support/seed";
import { ProjectReader } from "@/app/project-reader";
import { type SweepTarget, searchAllProjects } from "@/app/search-all-projects";
import { embedSweepQuery, sweepModelId } from "@/app/sweep-query";
import { embeddingsDisabled } from "@/embedding/create-provider";
import type { EmbeddingProvider } from "@/embedding/provider";
import { openDecisionsDb } from "@/storage/connection";
import { EmbeddingRepository } from "@/storage/embedding-repository";
import { migrate } from "@/storage/migrations";
import type { SaveContext } from "@/storage/node-repository";

const MODEL_ID = "test-model";

const context: SaveContext = {
	projectId: "project-1",
	sessionId: "session-1",
	commitSha: null,
	commitDirty: false,
};

class CountingProvider implements EmbeddingProvider {
	readonly modelId = MODEL_ID;
	queries = 0;

	async embedQuery(): Promise<Float32Array> {
		this.queries += 1;
		return new Float32Array([1, 0]);
	}

	async embedPassages(texts: string[]): Promise<Float32Array[]> {
		return texts.map(() => new Float32Array([1, 0]));
	}
}

let dirs: string[];

beforeEach(() => {
	dirs = [];
});

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeEmbeddedProject(canonicalId: string, title: string): SweepTarget {
	const root = mkdtempSync(join(tmpdir(), "cortex-sweep-query-"));
	dirs.push(root);
	const cortexDir = join(root, ".cortex");
	mkdirSync(cortexDir, { recursive: true });
	const db = openDecisionsDb(cortexDir);
	migrate(db);
	db.query(
		"INSERT INTO nodes (id, kind) VALUES ('project-1', 'project')",
	).run();
	db.query(
		"INSERT INTO nodes (id, kind) VALUES ('session-1', 'session')",
	).run();
	const decision = seedDecision(
		cortexDir,
		db,
		{
			title,
			body: "Corpo suficientemente longo para o schema de decisão passar.",
			keywords: ["auth", "jwt", "token", "login", "sessão"],
		},
		context,
	);
	new EmbeddingRepository(db).upsert(
		decision.id,
		MODEL_ID,
		new Float32Array([1, 0]),
	);
	db.close();
	return { root, canonicalId };
}

describe("cross-project sweep embedding", () => {
	test("embeds the query once, whatever the number of projects", async () => {
		const targets = Array.from({ length: 5 }, (_, index) =>
			makeEmbeddedProject(`github.com/acme/p${index}`, `Projeto ${index}`),
		);
		const provider = new CountingProvider();

		const vector = await embedSweepQuery(provider, "kubernetes ingress");
		const outcome = await searchAllProjects({
			targets,
			open: (root) => ProjectReader.open(root),
			terms: ["kubernetes", "ingress"],
			exact: false,
			vector,
		});

		expect(provider.queries).toBe(1);
		expect(outcome.projects).toHaveLength(5);
		for (const project of outcome.projects) {
			expect(project.results[0]?.source).toBe("vector");
		}
	});

	test("a store pinned to another model answers from FTS, not from foreign vectors", async () => {
		const target = makeEmbeddedProject("github.com/acme/alpha", "JWT no alpha");

		const outcome = await searchAllProjects({
			targets: [target],
			open: (root) => ProjectReader.open(root),
			terms: ["jwt"],
			exact: false,
			vector: { vector: new Float32Array([1, 0]), modelId: "other-model" },
		});

		expect(outcome.projects[0]?.results[0]?.source).toBe("fts");
	});

	test("a query that cannot be embedded degrades to no vector, not to an error", async () => {
		const failing: EmbeddingProvider = {
			modelId: MODEL_ID,
			embedQuery: () => Promise.reject(new Error("worker died")),
			embedPassages: () => Promise.reject(new Error("worker died")),
		};

		expect(await embedSweepQuery(failing, "kubernetes")).toBeNull();
	});

	test("the kill switch disables the sweep's embedding leg too", () => {
		const previous = process.env.CORTEX_DISABLE_EMBEDDINGS;
		try {
			process.env.CORTEX_DISABLE_EMBEDDINGS = "1";
			expect(embeddingsDisabled()).toBe(true);
			process.env.CORTEX_DISABLE_EMBEDDINGS = "0";
			expect(embeddingsDisabled()).toBe(false);
		} finally {
			process.env.CORTEX_DISABLE_EMBEDDINGS = previous;
		}
	});

	test("the sweep model is the current project's pinned one, or the default", async () => {
		const root = mkdtempSync(join(tmpdir(), "cortex-sweep-model-"));
		dirs.push(root);
		mkdirSync(join(root, ".cortex"), { recursive: true });
		await Bun.write(
			join(root, ".cortex", "config"),
			JSON.stringify({ model_id: "pinned-model", schema_version: 1 }),
		);

		expect(await sweepModelId(root)).toBe("pinned-model");
		expect(await sweepModelId(null)).not.toBe("pinned-model");
	});
});
