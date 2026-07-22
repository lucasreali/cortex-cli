import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatePrompt, promptTerms } from "@/app/prompt-gate";
import { openDecisionsDb } from "@/storage/connection";
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

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-prompt-gate-"));
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
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function store() {
	return { nodes, fts };
}

function saveDecision(title: string, keywords: string[], body?: string) {
	return nodes.createDecision(
		{
			title,
			body: body ?? "Corpo suficientemente longo para o schema passar.",
			keywords,
		},
		context,
	);
}

function saveJwtDecision() {
	return saveDecision(
		"Adotar JWT para autenticação",
		["auth", "jwt", "token", "login", "sessão"],
		"Tokens de acesso de curta duração assinados com RS256 para a API.",
	);
}

describe("promptTerms", () => {
	test("drops PT/EN stopwords, short tokens, and dedupes accent variants", () => {
		const terms = promptTerms(
			"Como funciona a sessao? Essa sessão deve usar o refresh token, certo?",
		);
		expect(terms).toEqual(["sessao", "refresh", "token", "certo"]);
	});

	test("caps the number of extracted terms", () => {
		const prompt = Array.from({ length: 40 }, (_, i) => `termo${i}`).join(" ");
		expect(promptTerms(prompt).length).toBe(24);
	});

	test("returns nothing for stopword-only or empty prompts", () => {
		expect(promptTerms("como faz para mudar isso aqui agora?")).toEqual([]);
		expect(promptTerms("")).toEqual([]);
	});
});

describe("gatePrompt", () => {
	test("keyword-column hit is a high match carrying the decision", () => {
		const decision = saveJwtDecision();

		const gate = gatePrompt(store(), "o fluxo de jwt está quebrado");

		expect(gate.tier).toBe("high");
		if (gate.tier === "none") throw new Error("unreachable");
		expect(gate.decisions.map((d) => d.id)).toEqual([decision.id]);
	});

	test("keyword match is accent-insensitive both ways", () => {
		saveJwtDecision();

		const gate = gatePrompt(store(), "revisar a expiração da sessao");

		expect(gate.tier).toBe("high");
	});

	test("title-only hit is a medium match", () => {
		const decision = saveJwtDecision();

		const gate = gatePrompt(store(), "vale a pena adotar outra abordagem?");

		expect(gate.tier).toBe("medium");
		if (gate.tier === "none") throw new Error("unreachable");
		expect(gate.decisions.map((d) => d.id)).toEqual([decision.id]);
	});

	test("body-only hit never gates", () => {
		saveJwtDecision();

		const gate = gatePrompt(store(), "assinatura rs256 no gateway");

		expect(gate.tier).toBe("none");
	});

	test("unrelated prompts stay silent", () => {
		saveJwtDecision();

		const gate = gatePrompt(store(), "melhora a paleta do gráfico de vendas");

		expect(gate.tier).toBe("none");
	});

	test("replaced decisions never surface", () => {
		const old = saveJwtDecision();
		nodes.replaceDecision(
			old.id,
			{
				title: "Sessões opacas no servidor",
				body: "Corpo suficientemente longo para o schema passar.",
				keywords: ["sessão", "opaque", "server", "auth", "redis"],
			},
			context,
		);

		const gate = gatePrompt(store(), "por que jwt?");

		expect(gate.tier).toBe("none");
	});

	test("high tier caps the number of injected decisions", () => {
		for (let i = 0; i < 5; i++) {
			saveDecision(`Decisão ${i} sobre paginação`, [
				"paginação",
				"cursor",
				"listagem",
				"api",
				`extra${i}`,
			]);
		}

		const gate = gatePrompt(store(), "como decidimos a paginação?");

		expect(gate.tier).toBe("high");
		if (gate.tier === "none") throw new Error("unreachable");
		expect(gate.decisions.length).toBe(3);
	});
});
