import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDecision } from "@tests/support/seed";
import { conflictCandidates } from "@/app/conflict-candidates";
import type { CreateDecisionInput, Decision } from "@/domain";
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
	dir = mkdtempSync(join(tmpdir(), "cortex-conflicts-"));
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

function seed(input: Partial<CreateDecisionInput> = {}): Decision {
	return seedDecision(
		dir,
		db,
		{
			title: "Autenticação stateless com JWT",
			body: "Corpo suficientemente longo para o schema de decisão passar.",
			keywords: ["auth", "jwt", "token", "login", "sessão"],
			module: "auth",
			...input,
		},
		context,
	);
}

function candidatesFor(
	input: Partial<CreateDecisionInput> = {},
): ReturnType<typeof conflictCandidates> {
	return conflictCandidates(
		{ nodes, fts },
		{
			title: "Migrar autenticação para sessões opacas",
			body: "Sessões opacas com introspecção substituem os tokens JWT.",
			keywords: ["auth", "jwt", "sessão", "session", "opaque"],
			module: "auth",
			...input,
		},
	);
}

describe("conflictCandidates", () => {
	test("flags a same-module decision sharing keywords, with the reason", () => {
		const existing = seed();

		const candidates = candidatesFor();

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toEqual({
			id: existing.id,
			title: existing.title,
			module: "auth",
			reason: expect.stringContaining("shares keywords: auth, jwt, sessão"),
		});
	});

	test("a decision in another module never qualifies through the module pool", () => {
		seed({
			module: "billing",
			title: "Cobrança valida tokens JWT localmente",
		});

		expect(candidatesFor()).toEqual([]);
	});

	test("already-linked decisions are never suggested", () => {
		const replaced = seed();
		const dependency = seed({ title: "Chaves RS256 no cofre de segredos" });
		const declared = seed({ title: "Tokens JWT expiram em quinze minutos" });

		const candidates = candidatesFor({
			replaces: replaced.id,
			depends_on: [dependency.id],
			conflicts_with: [declared.id],
		});

		const ids = candidates.map((candidate) => candidate.id);
		expect(ids).not.toContain(replaced.id);
		expect(ids).not.toContain(dependency.id);
		expect(ids).not.toContain(declared.id);
	});

	test("without a module both signals must agree", () => {
		const overlapOnly = seed({
			module: undefined,
			title: "Título sem termos da consulta",
			keywords: ["auth", "jwt", "cache", "redis", "ttl"],
		});

		const candidates = candidatesFor({ module: undefined });

		expect(candidates.map((candidate) => candidate.id)).toEqual([
			overlapOnly.id,
		]);
		expect(candidates[0]?.reason).toContain("full-text match");
	});

	test("caps the suggestions at three, most-overlapping first", () => {
		seed({
			title: "JWT assinado com RS256 na API",
			keywords: ["auth", "jwt", "rs256", "api", "chave"],
		});
		seed({
			title: "Refresh de sessão em cookie httpOnly",
			keywords: ["auth", "sessão", "cookie", "refresh", "web"],
		});
		seed({
			title: "Login social delegado ao provedor",
			keywords: ["auth", "login", "oauth", "social", "provedor"],
		});
		const closest = seed({
			title: "Sessões opacas rejeitadas na primeira avaliação",
			keywords: ["auth", "jwt", "sessão", "session", "opaque"],
		});

		const candidates = candidatesFor();

		expect(candidates).toHaveLength(3);
		expect(candidates[0]?.id).toBe(closest.id);
	});
});
