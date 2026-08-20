import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDecision } from "@tests/support/seed";
import { ProjectReader } from "@/app/project-reader";
import { type SweepTarget, searchAllProjects } from "@/app/search-all-projects";
import { openDecisionsDb } from "@/storage/connection";
import { migrate } from "@/storage/migrations";
import type { SaveContext } from "@/storage/node-repository";

const context: SaveContext = {
	projectId: "project-1",
	sessionId: "session-1",
	commitSha: null,
	commitDirty: false,
};

let dirs: string[];

beforeEach(() => {
	dirs = [];
});

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeProject(canonicalId: string, title: string): SweepTarget {
	const root = mkdtempSync(join(tmpdir(), "cortex-all-projects-"));
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
	seedDecision(
		cortexDir,
		db,
		{
			title,
			body: "Corpo suficientemente longo para o schema de decisão passar.",
			keywords: ["auth", "jwt", "token", "login", "sessão"],
		},
		context,
	);
	db.close();
	return { root, canonicalId };
}

function sweepOver(targets: SweepTarget[], terms: string[]) {
	return searchAllProjects({
		targets,
		open: (root) => ProjectReader.open(root),
		terms,
		exact: true,
		vector: null,
	});
}

describe("searchAllProjects", () => {
	test("returns results grouped and labeled per project, never merged", async () => {
		const alpha = makeProject("github.com/acme/alpha", "JWT no projeto alpha");
		const beta = makeProject("github.com/acme/beta", "JWT no projeto beta");

		const outcome = await sweepOver([alpha, beta], ["jwt"]);

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

		const outcome = await sweepOver(
			[alpha, { root: "/nowhere/broken", canonicalId: "broken" }],
			["jwt"],
		);

		expect(outcome.projects).toHaveLength(1);
		expect(outcome.skipped).toHaveLength(1);
		expect(outcome.skipped[0]?.root).toBe("/nowhere/broken");
		expect(outcome.skipped[0]?.reason).not.toBe("");
	});

	test("a project without matches still appears, empty", async () => {
		const alpha = makeProject("github.com/acme/alpha", "JWT no projeto alpha");

		const outcome = await sweepOver([alpha], ["kubernetes"]);

		expect(outcome.projects).toEqual([
			{ project: "github.com/acme/alpha", root: alpha.root, results: [] },
		]);
	});

	test("a foreign project is read, never migrated, reconciled or written to", async () => {
		const alpha = makeProject("github.com/acme/alpha", "JWT no projeto alpha");
		const cortexDir = join(alpha.root, ".cortex");
		const before = readdirSync(cortexDir).sort();
		const decisionsBefore = readdirSync(join(cortexDir, "decisions")).sort();

		await sweepOver([alpha], ["jwt"]);

		expect(readdirSync(cortexDir).sort()).toEqual(before);
		expect(readdirSync(join(cortexDir, "decisions")).sort()).toEqual(
			decisionsBefore,
		);
	});

	test("a store behind the current schema is skipped, not upgraded", async () => {
		const root = mkdtempSync(join(tmpdir(), "cortex-all-projects-old-"));
		dirs.push(root);
		const cortexDir = join(root, ".cortex");
		mkdirSync(cortexDir, { recursive: true });
		const db = openDecisionsDb(cortexDir);
		migrate(db);
		db.query(
			"DELETE FROM _migrations WHERE id = (SELECT MAX(id) FROM _migrations)",
		).run();
		db.close();

		const outcome = await sweepOver(
			[{ root, canonicalId: "github.com/acme/old" }],
			["jwt"],
		);

		expect(outcome.projects).toEqual([]);
		expect(outcome.skipped[0]?.reason).toContain("schema");
	});

	test("every store handle is closed, so a sweep leaves no descriptor behind", async () => {
		const targets = Array.from({ length: 8 }, (_, index) =>
			makeProject(`github.com/acme/p${index}`, `JWT no projeto ${index}`),
		);
		const baseline = openDescriptors();

		await sweepOver(targets, ["jwt"]);
		await sweepOver(targets, ["jwt"]);

		expect(openDescriptors()).toBeLessThanOrEqual(baseline);
	});

	test("projects beyond the cap are reported as unsearched, not dropped", async () => {
		const targets = [
			makeProject("github.com/acme/alpha", "JWT no projeto alpha"),
			makeProject("github.com/acme/beta", "JWT no projeto beta"),
			makeProject("github.com/acme/gamma", "JWT no projeto gamma"),
		];

		const outcome = await searchAllProjects(
			{
				targets,
				open: (root) => ProjectReader.open(root),
				terms: ["jwt"],
				exact: true,
				vector: null,
			},
			{ maxProjects: 1 },
		);

		expect(outcome.projects).toHaveLength(1);
		expect(outcome.skipped.map((entry) => entry.root)).toEqual(
			targets.slice(1).map((target) => target.root),
		);
		for (const entry of outcome.skipped) {
			expect(entry.reason).toContain("capped at 1 projects");
		}
	});

	test("a deadline that has passed leaves every remaining project unsearched", async () => {
		const targets = [
			makeProject("github.com/acme/alpha", "JWT no projeto alpha"),
			makeProject("github.com/acme/beta", "JWT no projeto beta"),
		];

		const outcome = await searchAllProjects(
			{
				targets,
				open: (root) => ProjectReader.open(root),
				terms: ["jwt"],
				exact: true,
				vector: null,
			},
			{ deadlineMs: 0 },
		);

		expect(outcome.projects).toEqual([]);
		expect(outcome.skipped).toHaveLength(2);
		for (const entry of outcome.skipped) {
			expect(entry.reason).toContain("deadline");
		}
	});
});

function openDescriptors(): number {
	return readdirSync("/dev/fd").length;
}
