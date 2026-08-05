import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDecision } from "@tests/support/seed";
import type { CortexRuntime } from "@/app/runtime";
import { searchAllProjects } from "@/app/search-all-projects";
import { SemanticSearch } from "@/embedding/semantic-search";
import { openDecisionsDb } from "@/storage/connection";
import { EmbeddingRepository } from "@/storage/embedding-repository";
import { migrate } from "@/storage/migrations";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";
import { SearchRepository } from "@/storage/search-repository";

const context: SaveContext = {
	projectId: "project-1",
	sessionId: "session-1",
	commitSha: null,
	commitDirty: false,
};

interface FakeProject {
	root: string;
	db: Database;
	runtime: CortexRuntime;
}

let dirs: string[];
let projects: Map<string, FakeProject>;

beforeEach(() => {
	dirs = [];
	projects = new Map();
});

afterEach(() => {
	for (const project of projects.values()) project.db.close();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeProject(canonicalId: string, title: string): FakeProject {
	const dir = mkdtempSync(join(tmpdir(), "cortex-all-projects-"));
	dirs.push(dir);
	const db = openDecisionsDb(dir);
	migrate(db);
	db.query(
		"INSERT INTO nodes (id, kind) VALUES ('project-1', 'project')",
	).run();
	db.query(
		"INSERT INTO nodes (id, kind) VALUES ('session-1', 'session')",
	).run();
	const nodes = new NodeRepository(db);
	const fts = new SearchRepository(db);
	const semanticSearch = new SemanticSearch({
		nodes,
		embeddings: new EmbeddingRepository(db),
		fts,
		provider: null,
	});
	seedDecision(
		dir,
		db,
		{
			title,
			body: "Corpo suficientemente longo para o schema de decisão passar.",
			keywords: ["auth", "jwt", "token", "login", "sessão"],
		},
		context,
	);
	const runtime = {
		projectCanonicalId: canonicalId,
		nodes,
		fts,
		semanticSearch,
	} as CortexRuntime;
	const project = { root: dir, db, runtime };
	projects.set(dir, project);
	return project;
}

async function open(root: string): Promise<CortexRuntime> {
	const project = projects.get(root);
	if (!project) throw new Error(`store unreadable at ${root}`);
	return project.runtime;
}

describe("searchAllProjects", () => {
	test("returns results grouped and labeled per project, never merged", async () => {
		const alpha = makeProject("github.com/acme/alpha", "JWT no projeto alpha");
		const beta = makeProject("github.com/acme/beta", "JWT no projeto beta");

		const outcome = await searchAllProjects(
			[alpha.root, beta.root],
			open,
			["jwt"],
			true,
		);

		expect(outcome.skipped).toEqual([]);
		expect(outcome.projects).toHaveLength(2);
		expect(outcome.projects[0]?.project).toBe("github.com/acme/alpha");
		expect(outcome.projects[0]?.results[0]?.node.title).toBe(
			"JWT no projeto alpha",
		);
		expect(outcome.projects[1]?.project).toBe("github.com/acme/beta");
		expect(outcome.projects[1]?.results[0]?.node.title).toBe(
			"JWT no projeto beta",
		);
	});

	test("a project that fails to open is skipped with its reason", async () => {
		const alpha = makeProject("github.com/acme/alpha", "JWT no projeto alpha");

		const outcome = await searchAllProjects(
			[alpha.root, "/nowhere/broken"],
			open,
			["jwt"],
			true,
		);

		expect(outcome.projects).toHaveLength(1);
		expect(outcome.skipped).toEqual([
			{
				root: "/nowhere/broken",
				reason: "store unreadable at /nowhere/broken",
			},
		]);
	});

	test("a project without matches still appears, empty", async () => {
		const alpha = makeProject("github.com/acme/alpha", "JWT no projeto alpha");

		const outcome = await searchAllProjects(
			[alpha.root],
			open,
			["kubernetes"],
			true,
		);

		expect(outcome.projects).toEqual([
			{ project: "github.com/acme/alpha", root: alpha.root, results: [] },
		]);
	});
});
