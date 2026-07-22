import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision, DecisionRecord } from "@/domain";
import { openDecisionsDb } from "@/storage/connection";
import { decisionFileName } from "@/storage/decision-file";
import { DecisionFileIndex } from "@/storage/decision-file-index";
import { DecisionFileStore } from "@/storage/decision-file-store";
import { DecisionSync } from "@/storage/decision-sync";
import { EdgeRepository } from "@/storage/edge-repository";
import { migrate } from "@/storage/migrations";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";

const PROJECT_ID = "project-1";
const SESSION_ID = "session-1";
const DECISION_A = "019f86dc-9878-7000-8907-d39b91633fc4";
const DECISION_B = "019f86ed-b7fb-7000-ba43-73cff203fffe";

let dir: string;
let db: Database;
let nodes: NodeRepository;
let edges: EdgeRepository;
let files: DecisionFileStore;
let index: DecisionFileIndex;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-sync-"));
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
	files = new DecisionFileStore(join(dir, "decisions"));
	index = new DecisionFileIndex(db);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function sync(): Promise<void> {
	return new DecisionSync({
		files,
		index,
		nodes,
		edges,
		projectId: PROJECT_ID,
	}).run();
}

function decision(id: string, overrides: Partial<Decision> = {}): Decision {
	return {
		id,
		title: `Decisão ${id.slice(-4)}`,
		body: "Corpo da decisão com contexto suficiente para o futuro.",
		keywords: ["um", "dois", "três", "four", "five"],
		module: null,
		status: "active",
		commitSha: null,
		commitDirty: false,
		provenance: "agent",
		props: null,
		createdAt: "2026-07-22T10:00:00.000Z",
		anchors: [],
		...overrides,
	};
}

async function writeFile(record: DecisionRecord): Promise<void> {
	await files.write(record);
}

describe("decision sync", () => {
	test("imports new files with anchors, depends_on and replaces links", async () => {
		await writeFile({
			decision: decision(DECISION_A, {
				anchors: [{ filePath: "src/a.ts", symbol: "A.run" }],
				status: "replaced",
			}),
			dependsOn: [],
			replaces: null,
		});
		await writeFile({
			decision: decision(DECISION_B),
			dependsOn: [DECISION_A],
			replaces: DECISION_A,
		});
		await sync();

		const imported = nodes.getById(DECISION_A);
		expect(imported?.status).toBe("replaced");
		expect(imported?.anchors).toEqual([
			{ filePath: "src/a.ts", symbol: "A.run" },
		]);
		expect(edges.dependsOnIds(DECISION_B)).toEqual([DECISION_A]);
		expect(edges.replacedSourceOf(DECISION_B)).toBe(DECISION_A);
	});

	test("second sync with unchanged files touches nothing", async () => {
		await writeFile({
			decision: decision(DECISION_A),
			dependsOn: [],
			replaces: null,
		});
		await sync();
		await sync();
		expect(nodes.listAllDecisions()).toHaveLength(1);
	});

	test("an edited file updates the node and keeps other nodes' edges", async () => {
		await writeFile({
			decision: decision(DECISION_A),
			dependsOn: [],
			replaces: null,
		});
		await writeFile({
			decision: decision(DECISION_B),
			dependsOn: [DECISION_A],
			replaces: null,
		});
		await sync();
		await writeFile({
			decision: decision(DECISION_A, { body: "Corpo reescrito após revisão." }),
			dependsOn: [],
			replaces: null,
		});
		await sync();

		expect(nodes.getById(DECISION_A)?.body).toBe(
			"Corpo reescrito após revisão.",
		);
		expect(edges.dependsOnIds(DECISION_B)).toEqual([DECISION_A]);
	});

	test("a passage change clears the stale embedding; a status flip keeps it", async () => {
		await writeFile({
			decision: decision(DECISION_A),
			dependsOn: [],
			replaces: null,
		});
		await sync();
		db.query(
			"INSERT INTO embeddings (node_id, model_id, dims, vector) VALUES (?, 'm', 1, ?)",
		).run(DECISION_A, new Uint8Array(4));

		await writeFile({
			decision: decision(DECISION_A, { status: "replaced" }),
			dependsOn: [],
			replaces: null,
		});
		await sync();
		expect(embeddingCount(DECISION_A)).toBe(1);

		await writeFile({
			decision: decision(DECISION_A, {
				status: "replaced",
				body: "Corpo novo que invalida o vetor antigo.",
			}),
			dependsOn: [],
			replaces: null,
		});
		await sync();
		expect(embeddingCount(DECISION_A)).toBe(0);
	});

	test("a deleted file removes the node and its edges", async () => {
		await writeFile({
			decision: decision(DECISION_A),
			dependsOn: [],
			replaces: null,
		});
		await writeFile({
			decision: decision(DECISION_B),
			dependsOn: [DECISION_A],
			replaces: null,
		});
		await sync();
		unlinkSync(join(dir, "decisions", decisionFileName(DECISION_A)));
		await sync();

		expect(nodes.getById(DECISION_A)).toBeNull();
		expect(nodes.getById(DECISION_B)).not.toBeNull();
		expect(edges.dependsOnIds(DECISION_B)).toEqual([]);
		expect(index.all().has(decisionFileName(DECISION_A))).toBe(false);
	});

	test("a db with decisions and no files dir bootstraps the export once", async () => {
		const context: SaveContext = {
			projectId: PROJECT_ID,
			sessionId: SESSION_ID,
			commitSha: "sha-1",
			commitDirty: false,
		};
		const created = nodes.createDecision(
			{
				title: "Adotar JWT para autenticação",
				body: "Tokens de curta duração assinados com RS256 para a API.",
				keywords: ["auth", "jwt", "token", "login", "api"],
				anchors: [{ file_path: "src/auth.ts" }],
			},
			context,
		);
		await sync();

		expect(files.exists()).toBe(true);
		const snapshot = await files.snapshot();
		const fileName = decisionFileName(created.id);
		expect(snapshot.has(fileName)).toBe(true);
		expect(snapshot.get(fileName)?.content).toContain(
			"Adotar JWT para autenticação",
		);
		expect(index.all().get(fileName)?.nodeId).toBe(created.id);

		await sync();
		expect(nodes.listAllDecisions()).toHaveLength(1);
	});

	test("a malformed file fails the sync loudly with the file name", async () => {
		await writeFile({
			decision: decision(DECISION_A),
			dependsOn: [],
			replaces: null,
		});
		await Bun.write(join(dir, "decisions", "broken.md"), "sem frontmatter");
		await expect(sync()).rejects.toThrow("invalid decision file broken.md");
	});
});

function embeddingCount(nodeId: string): number {
	const row = db
		.query<{ n: number }, [string]>(
			"SELECT COUNT(*) AS n FROM embeddings WHERE node_id = ?",
		)
		.get(nodeId);
	return row?.n ?? 0;
}
