import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDecision } from "@tests/support/seed";
import { CodeImpactAnalysis } from "@/app/code-impact";
import type { CreateDecisionInput, Decision } from "@/domain";
import { CodeRepository } from "@/storage/code-repository";
import { openCodeDb, openDecisionsDb } from "@/storage/connection";
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
let analysis: CodeImpactAnalysis;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-code-impact-"));
	decisionsDb = openDecisionsDb(dir);
	migrate(decisionsDb);
	decisionsDb
		.query("INSERT INTO nodes (id, kind) VALUES ('project-1', 'project')")
		.run();
	decisionsDb
		.query("INSERT INTO nodes (id, kind) VALUES ('session-1', 'session')")
		.run();
	nodes = new NodeRepository(decisionsDb);

	codeDb = openCodeDb(dir);
	migrateCode(codeDb);
	const code = new CodeRepository(codeDb);
	code.wipeAndRebuild([
		{
			file: {
				path: "src/auth/service.ts",
				lang: "ts",
				hash: "a",
				mtime: 1,
				ctime: 1,
				size: 1,
				hasError: false,
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
				ctime: 1,
				size: 1,
				hasError: false,
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
	analysis = new CodeImpactAnalysis(nodes, code);
});

afterEach(() => {
	decisionsDb.close();
	codeDb.close();
	rmSync(dir, { recursive: true, force: true });
});

function saveDecision(
	title: string,
	anchors: CreateDecisionInput["anchors"],
): Decision {
	return seedDecision(
		dir,
		decisionsDb,
		{
			title,
			body: "Corpo suficientemente longo para o schema de decisão passar.",
			keywords: ["um", "dois", "três", "four", "five"],
			anchors,
		},
		context,
	);
}

describe("CodeImpactAnalysis", () => {
	test("finds decisions anchored to transitive importers, with provenance", () => {
		const origin = saveDecision("Decisão de autenticação central", [
			{ file_path: "src/auth/service.ts" },
		]);
		const dependent = saveDecision("Decisão do endpoint de login", [
			{ file_path: "src/api/login.ts" },
		]);

		expect(analysis.forDecision(origin, 3)).toEqual({
			decisions: [
				{
					decision: expect.objectContaining({ id: dependent.id }),
					filePath: "src/api/login.ts",
					depth: 1,
					provenance: "heuristic",
				},
			],
			truncated: false,
		});
	});

	test("never reports the origin decision itself", () => {
		const origin = saveDecision("Decisão ancorada nos dois arquivos", [
			{ file_path: "src/auth/service.ts" },
			{ file_path: "src/api/login.ts" },
		]);

		expect(analysis.forDecision(origin, 3).decisions).toEqual([]);
	});

	test("a decision without anchors has no code impact", () => {
		const origin = saveDecision("Decisão sem âncora nenhuma", undefined);
		expect(analysis.forDecision(origin, 3)).toEqual({
			decisions: [],
			truncated: false,
		});
	});

	test("a decision anchored to a file nobody imports has no code impact", () => {
		const origin = saveDecision("Decisão na ponta do grafo", [
			{ file_path: "src/api/login.ts" },
		]);
		expect(analysis.forDecision(origin, 3).decisions).toEqual([]);
	});

	test("a decision on the same file is impact at depth 0", () => {
		const origin = saveDecision("Decisão de autenticação central", [
			{ file_path: "src/auth/service.ts" },
		]);
		const sibling = saveDecision("Outra decisão no mesmo serviço", [
			{ file_path: "src/auth/service.ts", symbol: "AuthService.login" },
		]);

		expect(analysis.forDecision(origin, 3).decisions[0]).toEqual({
			decision: expect.objectContaining({ id: sibling.id }),
			filePath: "src/auth/service.ts",
			depth: 0,
			provenance: "exact",
		});
	});

	test("orders by depth, closest first, one entry per decision", () => {
		const origin = saveDecision("Decisão de autenticação central", [
			{ file_path: "src/auth/service.ts" },
		]);
		const far = saveDecision("Decisão do endpoint de login", [
			{ file_path: "src/api/login.ts" },
		]);
		const near = saveDecision("Outra decisão no mesmo serviço", [
			{ file_path: "src/auth/service.ts" },
			{ file_path: "src/api/login.ts" },
		]);

		expect(
			analysis
				.forDecision(origin, 3)
				.decisions.map((entry) => [entry.decision.id, entry.depth]),
		).toEqual([
			[near.id, 0],
			[far.id, 1],
		]);
	});

	test("a directory anchor covers the files under it, from either side", () => {
		const origin = saveDecision("Decisão sobre o módulo de autenticação", [
			{ file_path: "src/auth" },
		]);
		const dependent = saveDecision("Decisão do diretório da API", [
			{ file_path: "src/api" },
		]);

		expect(analysis.forDecision(origin, 3).decisions).toEqual([
			{
				decision: expect.objectContaining({ id: dependent.id }),
				filePath: "src/api/login.ts",
				depth: 1,
				provenance: "heuristic",
			},
		]);
	});
});
