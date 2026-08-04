import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionStore } from "@/decisions/decision-store";
import { type DecisionSync, openDecisionSync } from "@/decisions/decision-sync";
import type { ReconcileReport } from "@/decisions/reconcile";
import type { CreateDecisionInput } from "@/domain";
import { openDecisionsDb } from "@/storage/connection";
import { migrate } from "@/storage/migrations";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";
import { SearchRepository } from "@/storage/search-repository";

const context: SaveContext = {
	projectId: "project-1",
	sessionId: "session-1",
	commitSha: "ca43a65",
	commitDirty: false,
};

let dir: string;
let db: Database;
let store: DecisionStore;
let nodes: NodeRepository;
let search: SearchRepository;
let reports: ReconcileReport[];
let sync: DecisionSync;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-decision-sync-"));
	db = openDecisionsDb(dir);
	migrate(db);
	db.query(
		"INSERT INTO nodes (id, kind) VALUES ('project-1', 'project')",
	).run();
	db.query(
		"INSERT INTO nodes (id, kind) VALUES ('session-1', 'session')",
	).run();
	store = DecisionStore.at(dir);
	nodes = new NodeRepository(db);
	search = new SearchRepository(db);
	reports = [];
	sync = openDecisionSync({
		cortexDir: dir,
		db,
		onReconciled: (report) => reports.push(report),
	});
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function decisionInput(
	overrides: Partial<CreateDecisionInput> = {},
): CreateDecisionInput {
	return {
		title: "Adotar JWT para autenticação",
		body: "Usamos JWTs de curta duração assinados com RS256 para a API.",
		keywords: ["autenticação", "authentication", "jwt", "login", "token"],
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

describe("DecisionSync.save", () => {
	test("writes the file first, then the row that mirrors it", () => {
		const saved = sync.save(
			decisionInput({
				module: "auth",
				anchors: [{ file_path: "src/auth/service.ts", symbol: "Auth.login" }],
			}),
			context,
		);

		expect(store.listIds()).toEqual([saved.id]);
		const decision = nodes.getById(saved.id);
		expect(decision?.module).toBe("auth");
		expect(decision?.commitSha).toBe("ca43a65");
		expect(decision?.createdAt).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
		);
		const parsed = store.read(saved.id);
		expect(parsed.ok && parsed.file.createdAt).toBe(
			decision?.createdAt as string,
		);
	});

	test("records where the decision was authored", () => {
		const saved = sync.save(decisionInput(), context);

		expect(edgeRows("BELONGS_TO")).toEqual([
			{ from_id: saved.id, to_id: "project-1" },
		]);
		expect(edgeRows("GENERATED_IN")).toEqual([
			{ from_id: saved.id, to_id: "session-1" },
		]);
	});

	test("supersedes through the same derivation every other machine runs", () => {
		const old = sync.save(decisionInput(), context);

		const replacement = sync.save(
			decisionInput({
				title: "Migrar de JWT para sessões opacas",
				replaces: old.id,
			}),
			context,
		);

		expect(nodes.getById(old.id)?.status).toBe("replaced");
		expect(edgeRows("REPLACED_BY")).toEqual([
			{ from_id: old.id, to_id: replacement.id },
		]);
		expect(nodes.listActive().map((decision) => decision.id)).toEqual([
			replacement.id,
		]);
	});

	test("links dependencies, and saving twice never collides on an edge", () => {
		const base = sync.save(decisionInput(), context);
		const first = sync.save(decisionInput({ depends_on: [base.id] }), context);
		const second = sync.save(decisionInput({ depends_on: [base.id] }), context);

		expect(edgeRows("DEPENDS_ON")).toEqual(
			[
				{ from_id: first.id, to_id: base.id },
				{ from_id: second.id, to_id: base.id },
			].sort((a, b) => a.from_id.localeCompare(b.from_id)),
		);
	});
});

describe("DecisionSync caching", () => {
	test("ensure reconciles once; resync always looks again", () => {
		sync.ensure();
		expect(reports).toHaveLength(1);

		sync.ensure();
		expect(reports).toHaveLength(1);

		sync.resync();
		expect(reports).toHaveLength(2);
	});

	test("save leaves the cache describing the branch as it now stands", () => {
		const saved = sync.save(decisionInput(), context);
		unlinkSync(store.pathFor(saved.id));

		expect(sync.ensure().absent).toEqual([]);
		expect(sync.resync().absent).toEqual([saved.id]);
	});
});

describe("switching branches costs nothing", () => {
	test("a decision leaves and returns without ever reaching the model", () => {
		const saved = sync.save(decisionInput(), context);
		const before = store.read(saved.id);
		const embedded = Float32Array.from([1, 0, 0, 0]);
		db.query(
			"INSERT INTO embeddings (node_id, model_id, dims, vector) VALUES (?, 'm@4', 4, ?)",
		).run(saved.id, new Uint8Array(embedded.buffer));

		unlinkSync(store.pathFor(saved.id));
		const left = sync.resync();

		expect(left.absent).toEqual([saved.id]);
		expect(search.searchExact(["autenticação"])).toEqual([]);
		expect(db.query("SELECT count(*) AS n FROM embeddings").get()).toEqual({
			n: 1,
		});

		if (!before.ok) throw new Error("the file should have parsed");
		store.write(before.file);
		const back = sync.resync();

		expect(back.restored).toEqual([saved.id]);
		// Nothing was imported, so nothing is enqueued: the stored vector is
		// still the right vector for a decision that never changed.
		expect(back.imported).toEqual([]);
		expect(
			search.searchExact(["autenticação"]).map((hit) => hit.nodeId),
		).toEqual([saved.id]);
	});
});
