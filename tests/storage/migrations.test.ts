import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeDb, openDecisionsDb } from "@/storage/connection";
import { migrate, migrateCode, SCHEMA_VERSION } from "@/storage/migrations";
import decisionsSchema from "@/storage/migrations/001-decisions-schema.sql" with {
	type: "text",
};
import decisionsPresent from "@/storage/migrations/004-decisions-present.sql" with {
	type: "text",
};
import decisionsGraphVocabulary from "@/storage/migrations/005-decisions-graph-vocabulary.sql" with {
	type: "text",
};
import migrationsTable from "@/storage/migrations/migrations-table.sql" with {
	type: "text",
};

let dir: string;
let db: Database;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-migrations-"));
	db = openDecisionsDb(dir);
	migrate(db);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function schemaNames(type: "table" | "index"): string[] {
	return db
		.query<{ name: string }, [string]>(
			"SELECT name FROM sqlite_master WHERE type = ?",
		)
		.all(type)
		.map((row) => row.name);
}

describe("connection", () => {
	test("applies WAL, foreign_keys and busy_timeout pragmas", () => {
		expect(db.query("PRAGMA journal_mode").get()).toEqual({
			journal_mode: "wal",
		});
		expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
		expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
	});

	// Switching a store to WAL takes it exclusively, and SQLite does not run
	// the busy handler for that switch — verified: it throws in 0 ms with
	// busy_timeout at 5 s. Opening retries instead, and only a lock nobody ever
	// releases gets to be an error.
	test("opening retries the WAL switch while another writer holds the store", () => {
		const heldDir = mkdtempSync(join(tmpdir(), "cortex-held-"));
		const holder = new Database(join(heldDir, "decisions.db"), {
			create: true,
		});
		try {
			holder.run("PRAGMA journal_mode = DELETE;");
			holder.run("CREATE TABLE placeholder (x)");
			holder.run("BEGIN IMMEDIATE");
			holder.run("INSERT INTO placeholder VALUES (1)");

			const started = Bun.nanoseconds();
			expect(() => openDecisionsDb(heldDir)).toThrow(/database is locked/);
			expect(Bun.nanoseconds() - started).toBeGreaterThan(100_000_000);
		} finally {
			holder.close();
			rmSync(heldDir, { recursive: true, force: true });
		}
	});

	test("opening a store another process already put in WAL leaves it alone", () => {
		const shared = openDecisionsDb(dir);
		try {
			expect(shared.query("PRAGMA journal_mode").get()).toEqual({
				journal_mode: "wal",
			});
		} finally {
			shared.close();
		}
	});
});

describe("migrations", () => {
	test("running twice on the same connection is a no-op", () => {
		expect(migrate(db)).toEqual([]);
		const rows = db.query("SELECT id, name FROM _migrations").all();
		expect(rows).toEqual([
			{ id: 1, name: "decisions-schema" },
			{ id: 2, name: "decisions-present" },
			{ id: 3, name: "decisions-graph-vocabulary" },
			{ id: 4, name: "decisions-project-identity" },
			{ id: 5, name: "decisions-no-self-edges" },
		]);
	});

	test("running again after reopening the database is a no-op", () => {
		db.close();
		db = openDecisionsDb(dir);
		expect(migrate(db)).toEqual([]);
		expect(db.query("SELECT count(*) AS n FROM _migrations").get()).toEqual({
			n: 5,
		});
	});

	test("reports the migrations it applied to a fresh database", () => {
		const fresh = openDecisionsDb(mkdtempSync(join(tmpdir(), "cortex-fresh-")));
		try {
			expect(migrate(fresh)).toEqual([
				"decisions-schema",
				"decisions-present",
				"decisions-graph-vocabulary",
				"decisions-project-identity",
				"decisions-no-self-edges",
			]);
		} finally {
			fresh.close();
		}
	});

	test("nodes.present defaults to 1 and is covered by the kind index", () => {
		db.query(
			"INSERT INTO nodes (id, kind, title) VALUES ('n1', 'decision', 'Some decision')",
		).run();
		expect(db.query("SELECT present FROM nodes WHERE id = 'n1'").get()).toEqual(
			{ present: 1 },
		);
		const index = db
			.query<{ sql: string }, []>(
				"SELECT sql FROM sqlite_master WHERE name = 'idx_nodes_kind_status'",
			)
			.get();
		expect(index?.sql).toContain("present");
	});

	test("creates the decisions.db tables", () => {
		const tables = schemaNames("table");
		for (const table of [
			"nodes",
			"anchors",
			"edges",
			"embeddings",
			"nodes_fts",
			"_migrations",
		]) {
			expect(tables).toContain(table);
		}
	});

	test("creates the indexes, including idx_edges_reverse", () => {
		const indexes = schemaNames("index");
		expect(indexes).toContain("idx_edges_reverse");
		expect(indexes).toContain("idx_nodes_kind_status");
		expect(indexes).toContain("idx_anchors_file_path");
	});

	test("nodes_fts is standalone fts5 with diacritics-insensitive tokenizer", () => {
		const row = db
			.query<{ sql: string }, []>(
				"SELECT sql FROM sqlite_master WHERE name = 'nodes_fts'",
			)
			.get();
		expect(row?.sql).toContain("fts5");
		expect(row?.sql).not.toContain("content=");
		expect(row?.sql).toContain("unicode61 remove_diacritics 2");
	});

	test("accepts the widened status and edge vocabulary", () => {
		db.query(
			"INSERT INTO nodes (id, kind, title, status) VALUES ('n1', 'decision', 'Old', 'archived')",
		).run();
		db.query(
			"INSERT INTO nodes (id, kind, title) VALUES ('n2', 'decision', 'New')",
		).run();
		db.query(
			"INSERT INTO edges (from_id, to_id, kind) VALUES ('n1', 'n2', 'CONFLICTS_WITH')",
		).run();
		db.query(
			"INSERT INTO edges (from_id, to_id, kind) VALUES ('n1', 'n2', 'ARCHIVED_BY')",
		).run();

		expect(db.query("SELECT count(*) AS n FROM edges").get()).toEqual({ n: 2 });
	});

	test("still rejects unknown statuses and edge kinds", () => {
		db.query(
			"INSERT INTO nodes (id, kind, title) VALUES ('n1', 'decision', 'Some')",
		).run();
		expect(() =>
			db.query("UPDATE nodes SET status = 'retired' WHERE id = 'n1'").run(),
		).toThrow();
		expect(() =>
			db
				.query(
					"INSERT INTO edges (from_id, to_id, kind) VALUES ('n1', 'n1', 'RELATES_TO')",
				)
				.run(),
		).toThrow();
	});

	test("still enforces foreign keys on the rebuilt edges table", () => {
		expect(() =>
			db
				.query(
					"INSERT INTO edges (from_id, to_id, kind) VALUES ('ghost', 'ghost', 'DEPENDS_ON')",
				)
				.run(),
		).toThrow();
	});

	test("the vocabulary rebuild carries a pre-005 store's data across", () => {
		const preDir = mkdtempSync(join(tmpdir(), "cortex-pre005-"));
		const pre = openDecisionsDb(preDir);
		try {
			pre.run(migrationsTable);
			pre.run(decisionsSchema);
			pre.run(decisionsPresent);
			pre
				.query("INSERT INTO _migrations (id, name) VALUES (?, ?)")
				.run(1, "decisions-schema");
			pre
				.query("INSERT INTO _migrations (id, name) VALUES (?, ?)")
				.run(2, "decisions-present");
			pre
				.query(
					`INSERT INTO nodes (id, kind, title, status, present)
				 VALUES ('n1', 'decision', 'Kept', 'replaced', 0)`,
				)
				.run();
			pre
				.query(
					"INSERT INTO nodes (id, kind, title) VALUES ('n2', 'decision', 'Other')",
				)
				.run();
			pre
				.query(
					"INSERT INTO edges (from_id, to_id, kind) VALUES ('n1', 'n2', 'REPLACED_BY')",
				)
				.run();

			expect(migrate(pre)).toEqual([
				"decisions-graph-vocabulary",
				"decisions-project-identity",
				"decisions-no-self-edges",
			]);
			expect(
				pre.query("SELECT status, present FROM nodes WHERE id = 'n1'").get(),
			).toEqual({ status: "replaced", present: 0 });
			expect(pre.query("SELECT count(*) AS n FROM edges").get()).toEqual({
				n: 1,
			});
			expect(pre.query("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(pre.query("PRAGMA foreign_keys").get()).toEqual({
				foreign_keys: 1,
			});
		} finally {
			pre.close();
			rmSync(preDir, { recursive: true, force: true });
		}
	});

	test("a rebuild that would carry broken references across refuses to commit", () => {
		const preDir = mkdtempSync(join(tmpdir(), "cortex-pre005-broken-"));
		const pre = openDecisionsDb(preDir);
		try {
			pre.run(migrationsTable);
			pre.run(decisionsSchema);
			pre.run(decisionsPresent);
			pre
				.query("INSERT INTO _migrations (id, name) VALUES (?, ?)")
				.run(1, "decisions-schema");
			pre
				.query("INSERT INTO _migrations (id, name) VALUES (?, ?)")
				.run(2, "decisions-present");
			pre.run("PRAGMA foreign_keys = OFF");
			pre
				.query(
					"INSERT INTO edges (from_id, to_id, kind) VALUES ('ghost', 'ghost', 'DEPENDS_ON')",
				)
				.run();
			pre.run("PRAGMA foreign_keys = ON");

			expect(() => migrate(pre)).toThrow(/foreign key violation/);
			expect(pre.query("SELECT count(*) AS n FROM _migrations").get()).toEqual({
				n: 2,
			});
			expect(pre.query("PRAGMA foreign_keys").get()).toEqual({
				foreign_keys: 1,
			});
		} finally {
			pre.close();
			rmSync(preDir, { recursive: true, force: true });
		}
	});

	// The reconciler drops a self-edge before it is offered, and this is what
	// makes it unrepresentable for anything else that writes.
	test("an edge from a decision to itself is refused", () => {
		db.query(
			"INSERT INTO nodes (id, kind, title) VALUES ('n1', 'decision', 'Alone')",
		).run();

		expect(() =>
			db
				.query(
					"INSERT INTO edges (from_id, to_id, kind) VALUES ('n1', 'n1', 'REPLACED_BY')",
				)
				.run(),
		).toThrow(/CHECK constraint failed/);
	});

	test("self-edges an older binary wrote are dropped by the upgrade", () => {
		const preDir = mkdtempSync(join(tmpdir(), "cortex-pre008-"));
		const pre = openDecisionsDb(preDir);
		try {
			pre.run(migrationsTable);
			pre.run(decisionsSchema);
			pre.run(decisionsPresent);
			for (const [id, name] of [
				[1, "decisions-schema"],
				[2, "decisions-present"],
			] as const) {
				pre
					.query("INSERT INTO _migrations (id, name) VALUES (?, ?)")
					.run(id, name);
			}
			pre
				.query(
					"INSERT INTO nodes (id, kind, title) VALUES ('n1', 'decision', 'Kept')",
				)
				.run();
			pre
				.query(
					"INSERT INTO nodes (id, kind, title) VALUES ('n2', 'decision', 'Other')",
				)
				.run();
			pre
				.query(
					"INSERT INTO edges (from_id, to_id, kind) VALUES ('n1', 'n1', 'REPLACED_BY')",
				)
				.run();
			pre
				.query(
					"INSERT INTO edges (from_id, to_id, kind) VALUES ('n1', 'n2', 'DEPENDS_ON')",
				)
				.run();

			migrate(pre);

			expect(pre.query("SELECT from_id, to_id, kind FROM edges").all()).toEqual(
				[{ from_id: "n1", to_id: "n2", kind: "DEPENDS_ON" }],
			);
			expect(pre.query("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			pre.close();
			rmSync(preDir, { recursive: true, force: true });
		}
	});

	test("split project identities are merged onto the oldest row", () => {
		const preDir = mkdtempSync(join(tmpdir(), "cortex-pre006-"));
		const pre = openDecisionsDb(preDir);
		try {
			pre.run(migrationsTable);
			pre.run(decisionsSchema);
			pre.run(decisionsPresent);
			pre.run(decisionsGraphVocabulary);
			for (const [id, name] of [
				[1, "decisions-schema"],
				[2, "decisions-present"],
				[3, "decisions-graph-vocabulary"],
			] as Array<[number, string]>) {
				pre
					.query("INSERT INTO _migrations (id, name) VALUES (?, ?)")
					.run(id, name);
			}
			for (const id of ["p1", "p2"]) {
				pre
					.query("INSERT INTO nodes (id, kind, title) VALUES (?, 'project', ?)")
					.run(id, "github.com/acme/app");
			}
			for (const id of ["s1", "s2"]) {
				pre.query("INSERT INTO nodes (id, kind) VALUES (?, 'session')").run(id);
			}
			pre
				.query(
					"INSERT INTO edges (from_id, to_id, kind) VALUES ('s1', 'p1', 'BELONGS_TO')",
				)
				.run();
			pre
				.query(
					"INSERT INTO edges (from_id, to_id, kind) VALUES ('s2', 'p2', 'BELONGS_TO')",
				)
				.run();

			expect(migrate(pre)).toEqual([
				"decisions-project-identity",
				"decisions-no-self-edges",
			]);
			expect(
				pre.query("SELECT id FROM nodes WHERE kind = 'project'").all(),
			).toEqual([{ id: "p1" }]);
			expect(
				pre
					.query(
						"SELECT from_id FROM edges WHERE to_id = 'p1' ORDER BY from_id",
					)
					.all(),
			).toEqual([{ from_id: "s1" }, { from_id: "s2" }]);
			expect(pre.query("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			pre.close();
			rmSync(preDir, { recursive: true, force: true });
		}
	});

	test("a store written by a newer cortex is refused, not written to", () => {
		db.query(
			"INSERT INTO _migrations (id, name) VALUES (99, 'from-the-future')",
		).run();

		expect(() => migrate(db)).toThrow(
			"decisions.db is at schema v99, newer than the v" +
				`${SCHEMA_VERSION} this cortex knows — run: cortex upgrade`,
		);
	});

	test("code.db names itself when it is the one from the future", () => {
		const codeDir = mkdtempSync(join(tmpdir(), "cortex-code-future-"));
		const code = openCodeDb(codeDir);
		try {
			migrateCode(code);
			code
				.query(
					"INSERT INTO _migrations (id, name) VALUES (99, 'from-the-future')",
				)
				.run();
			expect(() => migrateCode(code)).toThrow(/^code\.db is at schema v99/);
		} finally {
			code.close();
			rmSync(codeDir, { recursive: true, force: true });
		}
	});

	test("anchors.symbol defaults to empty string", () => {
		db.query(
			"INSERT INTO nodes (id, kind, title) VALUES ('n1', 'decision', 'Some decision')",
		).run();
		db.query(
			"INSERT INTO anchors (node_id, file_path) VALUES ('n1', 'src/a.ts')",
		).run();
		expect(db.query("SELECT symbol FROM anchors").get()).toEqual({
			symbol: "",
		});
	});
});

describe("full-text search", () => {
	test("'decisao' matches a record containing 'decisão'", () => {
		db.query(
			`INSERT INTO nodes_fts (node_id, title, body, keywords)
			 VALUES ('n1', 'Decisão de autenticação', 'Usamos JWT.', 'auth jwt')`,
		).run();
		const hits = db
			.query<{ node_id: string }, []>(
				"SELECT node_id FROM nodes_fts WHERE nodes_fts MATCH 'decisao'",
			)
			.all();
		expect(hits).toEqual([{ node_id: "n1" }]);
	});
});
