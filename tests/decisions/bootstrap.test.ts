import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	exportDecisionsIfNeeded,
	exportExistingDecisions,
} from "@/decisions/bootstrap";
import { DecisionStore } from "@/decisions/decision-store";
import type { DecisionFile } from "@/domain";
import { openDecisionsDb } from "@/storage/connection";
import { DecisionSyncRepository } from "@/storage/decision-sync-repository";
import { migrate } from "@/storage/migrations";
import decisionsSchema from "@/storage/migrations/001-decisions-schema.sql" with {
	type: "text",
};
import migrationsTable from "@/storage/migrations/migrations-table.sql" with {
	type: "text",
};

// M1: `grep -rn exportDecisionsIfNeeded tests/` used to return nothing. It is
// reached on every fresh store, where it runs against an empty database and
// satisfies line coverage with a no-op — and the migration test seeded by
// running 001 *and* 004 raw, so it started at v2 and nothing ever applied
// 004-decisions-present.sql to a populated v1 store. Both halves of the upgrade
// users are about to perform were untested, and the failure they hide is
// data-loss-shaped: a store that predates `.cortex/decisions/` exporting
// nothing to markdown, on the release where everyone upgrades.

const OLD = "019f0000-0000-7000-8000-00000000000a";
const NEW = "019f0000-0000-7000-8000-00000000000b";
const DEPENDENCY = "019f0000-0000-7000-8000-00000000000c";
const PROJECT = "019f0000-0000-7000-8000-0000000000f0";
const SESSION = "019f0000-0000-7000-8000-0000000000f1";

let dir: string;
let cortexDir: string;
let db: Database;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-bootstrap-"));
	cortexDir = join(dir, ".cortex");
	mkdirSync(cortexDir, { recursive: true });
	db = openDecisionsDb(cortexDir);
	seedVersionOneStore();
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

// A v1 store as the first released version left it: 001 applied, nothing else,
// and `_migrations` saying exactly that.
function seedVersionOneStore(): void {
	db.run(migrationsTable);
	db.run(decisionsSchema);
	db.query("INSERT INTO _migrations (id, name) VALUES (?, ?)").run(
		1,
		"decisions-schema",
	);
	insertNode(PROJECT, "project", null);
	insertNode(SESSION, "session", null);
	insertDecision(OLD, "Sessões em memória", "replaced");
	insertDecision(NEW, "Adotar JWT para autenticação", "active");
	insertDecision(DEPENDENCY, "Padronizar RS256", "active");
	insertEdge(OLD, NEW, "REPLACED_BY");
	insertEdge(NEW, DEPENDENCY, "DEPENDS_ON");
	insertEdge(NEW, PROJECT, "BELONGS_TO");
	insertEdge(NEW, SESSION, "GENERATED_IN");
	db.query(
		"INSERT INTO anchors (node_id, file_path, symbol) VALUES (?, ?, ?)",
	).run(NEW, "src/auth/token.ts", "signToken");
	db.query(
		"INSERT INTO anchors (node_id, file_path, symbol) VALUES (?, ?, ?)",
	).run(NEW, "src/auth/README.md", "");
	db.query(
		"INSERT INTO embeddings (node_id, model_id, dims, vector) VALUES (?, ?, ?, ?)",
	).run(NEW, "embeddinggemma-300m-q8@256", 2, new Uint8Array(8));
}

function insertNode(id: string, kind: string, title: string | null): void {
	db.query("INSERT INTO nodes (id, kind, title) VALUES (?, ?, ?)").run(
		id,
		kind,
		title,
	);
}

function insertDecision(id: string, title: string, status: string): void {
	db.query(
		`INSERT INTO nodes
			(id, kind, title, body, keywords, module, status, commit_sha,
			 commit_dirty, provenance, created_at)
		 VALUES (?, 'decision', ?, ?, ?, ?, ?, ?, 0, 'agent', ?)`,
	).run(
		id,
		title,
		`Corpo de ${title}, escrito antes de .cortex/decisions/ existir.`,
		JSON.stringify(["jwt", "autenticação", "token", "login", "sessão"]),
		"auth",
		status,
		"c0ffee",
		"2026-07-22T14:03:11.204Z",
	);
}

function insertEdge(from: string, to: string, kind: string): void {
	db.query("INSERT INTO edges (from_id, to_id, kind) VALUES (?, ?, ?)").run(
		from,
		to,
		kind,
	);
}

function exportedIds(): string[] {
	return readdirSync(join(cortexDir, "decisions"))
		.filter((name) => name.endsWith(".md"))
		.map((name) => name.slice(0, -3))
		.sort();
}

function readExported(id: string): DecisionFile {
	const parse = DecisionStore.at(cortexDir).read(id);
	if (!parse.ok) throw new Error(`${id} did not parse: ${parse.reason}`);
	return parse.file;
}

describe("upgrading a populated v1 decisions store", () => {
	test("applies every migration after the one it stopped at", () => {
		expect(migrate(db)).toEqual([
			"decisions-present",
			"decisions-graph-vocabulary",
			"decisions-project-identity",
			"decisions-no-self-edges",
		]);
	});

	// 004 is an ALTER TABLE plus a DROP INDEX and a recreate; 005 drops and
	// rebuilds `edges` outright. Neither had ever met rows before.
	test("carries the rows across, present by default", () => {
		migrate(db);

		expect(
			db
				.query(
					"SELECT id, status, present FROM nodes WHERE kind = 'decision' ORDER BY id",
				)
				.all(),
		).toEqual([
			{ id: OLD, status: "replaced", present: 1 },
			{ id: NEW, status: "active", present: 1 },
			{ id: DEPENDENCY, status: "active", present: 1 },
		]);
		expect(db.query("SELECT count(*) AS n FROM edges").get()).toEqual({ n: 4 });
		expect(db.query("SELECT count(*) AS n FROM anchors").get()).toEqual({
			n: 2,
		});
		expect(db.query("SELECT count(*) AS n FROM embeddings").get()).toEqual({
			n: 1,
		});
		expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
	});

	test("the rebuilt index leads with kind and status, and ends with present", () => {
		migrate(db);

		const index = db
			.query<{ sql: string }, []>(
				"SELECT sql FROM sqlite_master WHERE name = 'idx_nodes_kind_status'",
			)
			.get();
		expect(index?.sql).toContain("(kind, status, present)");
	});

	test("writes one markdown file per decision, and only for decisions", () => {
		exportDecisionsIfNeeded(cortexDir, db, migrate(db));

		expect(exportedIds()).toEqual([OLD, NEW, DEPENDENCY].sort());
	});

	// REPLACED_BY points from the old decision to the new one; the file records
	// the link on the new one, which is what keeps decision files write-once.
	test("the exported files carry the graph the store held", () => {
		exportDecisionsIfNeeded(cortexDir, db, migrate(db));

		const replacement = readExported(NEW);
		expect(replacement.replaces).toBe(OLD);
		expect(replacement.dependsOn).toEqual([DEPENDENCY]);
		expect(replacement.module).toBe("auth");
		expect(replacement.commitSha).toBe("c0ffee");
		expect(replacement.createdAt).toBe("2026-07-22T14:03:11.204Z");
		expect(replacement.anchors).toEqual([
			{ filePath: "src/auth/README.md", symbol: "" },
			{ filePath: "src/auth/token.ts", symbol: "signToken" },
		]);
		expect(readExported(OLD).replaces).toBeNull();
	});

	// BELONGS_TO and GENERATED_IN are local facts about this machine, not
	// versioned ones: a decision imported from someone else's branch never
	// happened in a session here.
	test("nothing local to this machine reaches a file", () => {
		exportDecisionsIfNeeded(cortexDir, db, migrate(db));

		expect(exportedIds()).not.toContain(PROJECT);
		expect(exportedIds()).not.toContain(SESSION);
		for (const id of exportedIds()) {
			expect(
				Bun.file(join(cortexDir, "decisions", `${id}.md`)).text(),
			).resolves.not.toContain(SESSION);
		}
	});

	// The export runs once, keyed off the migration that introduces the
	// directory. From then on the file is written before the row.
	test("a store already on this schema exports nothing", () => {
		exportDecisionsIfNeeded(cortexDir, db, migrate(db));
		rmSync(join(cortexDir, "decisions"), { recursive: true, force: true });

		exportDecisionsIfNeeded(cortexDir, db, migrate(db));

		expect(readdirSync(cortexDir)).not.toContain("decisions");
	});

	test("an empty store exports nothing at all", () => {
		db.run("DELETE FROM edges");
		db.run("DELETE FROM nodes");

		exportDecisionsIfNeeded(cortexDir, db, migrate(db));

		expect(readdirSync(cortexDir)).not.toContain("decisions");
	});

	test("it reports the ids it wrote", () => {
		migrate(db);

		expect(
			exportExistingDecisions({
				store: DecisionStore.at(cortexDir),
				repository: new DecisionSyncRepository(db),
			}).sort(),
		).toEqual([OLD, NEW, DEPENDENCY].sort());
	});
});
