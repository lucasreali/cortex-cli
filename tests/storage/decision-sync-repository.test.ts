import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionFile } from "@/domain";
import { openDecisionsDb } from "@/storage/connection";
import { DecisionSyncRepository } from "@/storage/decision-sync-repository";
import { migrate } from "@/storage/migrations";
import { NodeRepository } from "@/storage/node-repository";

const PROJECT_ID = "project-1";
const SESSION_ID = "session-1";
const FIRST = "019f0000-0000-7000-8000-000000000001";
const SECOND = "019f0000-0000-7000-8000-000000000002";

let dir: string;
let db: Database;
let sync: DecisionSyncRepository;
let nodes: NodeRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-decision-sync-"));
	db = openDecisionsDb(dir);
	migrate(db);
	db.query(
		"INSERT INTO nodes (id, kind, title) VALUES (?, 'project', 'github.com/acme/app')",
	).run(PROJECT_ID);
	db.query("INSERT INTO nodes (id, kind) VALUES (?, 'session')").run(
		SESSION_ID,
	);
	sync = new DecisionSyncRepository(db);
	nodes = new NodeRepository(db);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function decisionFile(overrides: Partial<DecisionFile> = {}): DecisionFile {
	return {
		id: FIRST,
		title: "Adotar JWT para autenticação",
		body: "Usamos JWTs de curta duração assinados com RS256 para a API.",
		keywords: ["autenticação", "authentication", "jwt", "login", "token"],
		module: null,
		replaces: null,
		dependsOn: [],
		anchors: [],
		commitSha: null,
		commitDirty: false,
		provenance: "agent",
		createdAt: "2026-07-22T14:03:11.204Z",
		...overrides,
	};
}

function edgeRows(kind: string): Array<{ from_id: string; to_id: string }> {
	return db
		.query<{ from_id: string; to_id: string }, [string]>(
			"SELECT from_id, to_id FROM edges WHERE kind = ? ORDER BY from_id, to_id",
		)
		.all(kind);
}

describe("DecisionSyncRepository.insertDecision", () => {
	test("keeps the file's id and timestamp, and indexes it for search", () => {
		sync.insertDecision(
			decisionFile({
				module: "auth",
				anchors: [
					{ filePath: "src/auth/service.ts", symbol: "AuthService.login" },
					{ filePath: "src/auth/jwt.ts", symbol: "" },
				],
				commitSha: "ca43a65",
				commitDirty: true,
			}),
			null,
		);

		expect(nodes.getById(FIRST)).toEqual({
			id: FIRST,
			title: "Adotar JWT para autenticação",
			body: "Usamos JWTs de curta duração assinados com RS256 para a API.",
			keywords: ["autenticação", "authentication", "jwt", "login", "token"],
			module: "auth",
			status: "active",
			present: true,
			commitSha: "ca43a65",
			commitDirty: true,
			provenance: "agent",
			props: null,
			createdAt: "2026-07-22T14:03:11.204Z",
			anchors: [
				{ filePath: "src/auth/jwt.ts", symbol: "" },
				{ filePath: "src/auth/service.ts", symbol: "AuthService.login" },
			],
		});
		expect(db.query("SELECT count(*) AS n FROM nodes_fts").get()).toEqual({
			n: 1,
		});
	});

	test("without local links it records no session, as on someone else's branch", () => {
		sync.insertDecision(decisionFile(), null);

		expect(edgeRows("BELONGS_TO")).toEqual([]);
		expect(edgeRows("GENERATED_IN")).toEqual([]);
	});

	test("with local links it records where the decision was authored", () => {
		sync.insertDecision(decisionFile(), {
			projectId: PROJECT_ID,
			sessionId: SESSION_ID,
		});

		expect(edgeRows("BELONGS_TO")).toEqual([
			{ from_id: FIRST, to_id: PROJECT_ID },
		]);
		expect(edgeRows("GENERATED_IN")).toEqual([
			{ from_id: FIRST, to_id: SESSION_ID },
		]);
	});
});

describe("DecisionSyncRepository presence and status", () => {
	beforeEach(() => {
		sync.insertDecision(decisionFile(), null);
		sync.insertDecision(decisionFile({ id: SECOND }), null);
	});

	test("listPresence reports every decision, flagged", () => {
		sync.setPresent([SECOND], false);

		expect(sync.listPresence()).toEqual([
			{ id: FIRST, present: true },
			{ id: SECOND, present: false },
		]);
		expect(sync.listAbsent()).toEqual([
			{ id: SECOND, title: "Adotar JWT para autenticação" },
		]);
	});

	test("setPresent on an empty list touches nothing", () => {
		sync.setPresent([], false);

		expect(sync.listAbsent()).toEqual([]);
	});

	test("applyStatuses is absolute — it revives what it no longer names", () => {
		sync.applyStatuses([FIRST]);
		expect(nodes.getById(FIRST)?.status).toBe("replaced");

		sync.applyStatuses([]);
		expect(nodes.getById(FIRST)?.status).toBe("active");
	});
});

describe("DecisionSyncRepository versioned edges", () => {
	beforeEach(() => {
		sync.insertDecision(decisionFile(), null);
		sync.insertDecision(decisionFile({ id: SECOND }), null);
	});

	test("inserting the same edge twice is a no-op, not a constraint error", () => {
		sync.insertVersionedEdge(SECOND, "DEPENDS_ON", FIRST);
		sync.insertVersionedEdge(SECOND, "DEPENDS_ON", FIRST);

		expect(edgeRows("DEPENDS_ON")).toEqual([{ from_id: SECOND, to_id: FIRST }]);
	});

	test("clearing drops only the versioned kinds", () => {
		sync.insertVersionedEdge(SECOND, "DEPENDS_ON", FIRST);
		sync.insertVersionedEdge(FIRST, "REPLACED_BY", SECOND);
		db.query(
			"INSERT INTO edges (from_id, to_id, kind) VALUES (?, ?, 'BELONGS_TO')",
		).run(FIRST, PROJECT_ID);

		sync.clearVersionedEdges();

		expect(edgeRows("DEPENDS_ON")).toEqual([]);
		expect(edgeRows("REPLACED_BY")).toEqual([]);
		expect(edgeRows("BELONGS_TO")).toEqual([
			{ from_id: FIRST, to_id: PROJECT_ID },
		]);
	});
});

describe("DecisionSyncRepository.listExportRows", () => {
	test("rebuilds the versioned form, inverting REPLACED_BY into replaces", () => {
		const file = decisionFile({
			module: "auth",
			anchors: [
				{ filePath: "src/auth/service.ts", symbol: "AuthService.login" },
				{ filePath: "src/auth/jwt.ts", symbol: "" },
			],
			commitSha: "ca43a65",
			commitDirty: true,
		});
		sync.insertDecision(file, null);
		sync.insertDecision(decisionFile({ id: SECOND }), null);
		sync.insertVersionedEdge(FIRST, "REPLACED_BY", SECOND);
		sync.insertVersionedEdge(SECOND, "DEPENDS_ON", FIRST);

		expect(sync.listExportRows()).toEqual([
			{
				...file,
				anchors: [
					{ filePath: "src/auth/jwt.ts", symbol: "" },
					{ filePath: "src/auth/service.ts", symbol: "AuthService.login" },
				],
			},
			decisionFile({ id: SECOND, replaces: FIRST, dependsOn: [FIRST] }),
		]);
	});

	test("an empty store exports nothing", () => {
		expect(sync.listExportRows()).toEqual([]);
	});
});

describe("DecisionSyncRepository.transaction", () => {
	test("rolls the whole reconcile back when one step fails", () => {
		expect(() =>
			sync.transaction(() => {
				sync.insertDecision(decisionFile(), null);
				throw new Error("boom");
			}),
		).toThrow("boom");

		expect(sync.listPresence()).toEqual([]);
	});
});
