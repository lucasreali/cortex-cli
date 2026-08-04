import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decisionImpact } from "@/app/decision-impact";
import type { CreateDecisionInput, Decision } from "@/domain";
import type { CodeIndex } from "@/indexer/lazy-code-index";
import { CodeRepository } from "@/storage/code-repository";
import { openCodeDb, openDecisionsDb } from "@/storage/connection";
import { EdgeRepository } from "@/storage/edge-repository";
import { migrate, migrateCode } from "@/storage/migrations";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";

const context: SaveContext = {
	projectId: "project-1",
	sessionId: "session-1",
	commitSha: null,
	commitDirty: false,
};

let dir: string;
let decisionsDb: Database;
let codeDb: Database;
let nodes: NodeRepository;
let edges: EdgeRepository;
let code: CodeRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-decision-impact-"));
	decisionsDb = openDecisionsDb(dir);
	migrate(decisionsDb);
	decisionsDb
		.query("INSERT INTO nodes (id, kind) VALUES ('project-1', 'project')")
		.run();
	decisionsDb
		.query("INSERT INTO nodes (id, kind) VALUES ('session-1', 'session')")
		.run();
	nodes = new NodeRepository(decisionsDb);
	edges = new EdgeRepository(decisionsDb);

	codeDb = openCodeDb(dir);
	migrateCode(codeDb);
	code = new CodeRepository(codeDb);
	code.wipeAndRebuild([
		{
			file: {
				path: "src/auth/service.ts",
				lang: "ts",
				hash: "a",
				mtime: 1,
				size: 1,
			},
			symbols: [],
			imports: [],
		},
		{
			file: {
				path: "src/api/login.ts",
				lang: "ts",
				hash: "b",
				mtime: 1,
				size: 1,
			},
			symbols: [],
			imports: [
				{
					specifier: "../auth/service",
					toPath: "src/auth/service.ts",
					provenance: "heuristic",
				},
			],
		},
	]);
});

afterEach(() => {
	decisionsDb.close();
	codeDb.close();
	rmSync(dir, { recursive: true, force: true });
});

function runtime(codeIndex: CodeIndex = workingCodeIndex()) {
	return { nodes, edges, codeIndex };
}

function workingCodeIndex(): CodeIndex {
	return { repository: async () => code, dispose() {} };
}

function brokenCodeIndex(error: unknown): CodeIndex {
	return {
		repository: () => Promise.reject(error),
		dispose() {},
	};
}

function saveDecision(
	title: string,
	extra: Partial<CreateDecisionInput> = {},
): Decision {
	return nodes.createDecision(
		{
			title,
			body: "Corpo suficientemente longo para o schema de decisão passar.",
			keywords: ["um", "dois", "três", "four", "five"],
			...extra,
		},
		context,
	);
}

describe("decisionImpact", () => {
	test("returns null for an unknown decision id", async () => {
		expect(await decisionImpact(runtime(), Bun.randomUUIDv7())).toBeNull();
	});

	test("walks DEPENDS_ON links and reports depth per decision", async () => {
		const base = saveDecision("Decisão base do esquema de autenticação");
		const middle = saveDecision("Decisão intermediária de tokens", {
			depends_on: [base.id],
		});
		const leaf = saveDecision("Decisão folha do endpoint de login", {
			depends_on: [middle.id],
		});

		const impact = await decisionImpact(runtime(), base.id);

		expect(impact?.root.id).toBe(base.id);
		expect(impact?.impacted).toEqual([
			{ node: expect.objectContaining({ id: middle.id }), depth: 1 },
			{ node: expect.objectContaining({ id: leaf.id }), depth: 2 },
		]);
		expect(impact?.codeWarning).toBeNull();
	});

	test("skips decisions absent from this branch, root and impacted alike", async () => {
		const base = saveDecision("Decisão base do esquema de autenticação");
		const middle = saveDecision("Decisão intermediária de tokens", {
			depends_on: [base.id],
		});
		const leaf = saveDecision("Decisão folha do endpoint de login", {
			depends_on: [middle.id],
		});
		decisionsDb
			.query("UPDATE nodes SET present = 0 WHERE id = ?")
			.run(middle.id);

		const impact = await decisionImpact(runtime(), base.id);

		expect(impact?.impacted).toEqual([
			{ node: expect.objectContaining({ id: leaf.id }), depth: 2 },
		]);
		expect(await decisionImpact(runtime(), middle.id)).toBeNull();
	});

	test("a decision without anchors never touches the code index", async () => {
		const decision = saveDecision("Decisão sem âncora nenhuma");

		const impact = await decisionImpact(
			runtime(brokenCodeIndex(new Error("must not be called"))),
			decision.id,
		);

		expect(impact?.codeImpacted).toEqual([]);
		expect(impact?.codeWarning).toBeNull();
	});

	test("finds decisions anchored to transitive importers of the anchored files", async () => {
		const origin = saveDecision("Decisão de autenticação central", {
			anchors: [{ file_path: "src/auth/service.ts" }],
		});
		const dependent = saveDecision("Decisão do endpoint de login", {
			anchors: [{ file_path: "src/api/login.ts" }],
		});

		const impact = await decisionImpact(runtime(), origin.id);

		expect(impact?.codeImpacted).toEqual([
			{
				decision: expect.objectContaining({ id: dependent.id }),
				filePath: "src/api/login.ts",
				depth: 1,
				provenance: "heuristic",
			},
		]);
		expect(impact?.codeWarning).toBeNull();
	});

	test("an unavailable code index degrades to a warning, not an error", async () => {
		const origin = saveDecision("Decisão de autenticação central", {
			anchors: [{ file_path: "src/auth/service.ts" }],
		});

		const impact = await decisionImpact(
			runtime(brokenCodeIndex(new Error("grammar download failed"))),
			origin.id,
		);

		expect(impact?.codeImpacted).toEqual([]);
		expect(impact?.codeWarning).toBe(
			"code index unavailable: grammar download failed",
		);
	});

	test("a non-Error failure is stringified into the warning", async () => {
		const origin = saveDecision("Decisão de autenticação central", {
			anchors: [{ file_path: "src/auth/service.ts" }],
		});

		const impact = await decisionImpact(
			runtime(brokenCodeIndex("disk on fire")),
			origin.id,
		);

		expect(impact?.codeWarning).toBe("code index unavailable: disk on fire");
	});
});
