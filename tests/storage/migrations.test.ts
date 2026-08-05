import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "@/storage/connection";
import { migrate } from "@/storage/migrations";
import decisionsSchema from "@/storage/migrations/001-decisions-schema.sql" with {
	type: "text",
};
import decisionsPresent from "@/storage/migrations/004-decisions-present.sql" with {
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
});

describe("migrations", () => {
	test("running twice on the same connection is a no-op", () => {
		expect(migrate(db)).toEqual([]);
		const rows = db.query("SELECT id, name FROM _migrations").all();
		expect(rows).toEqual([
			{ id: 1, name: "decisions-schema" },
			{ id: 2, name: "decisions-present" },
			{ id: 3, name: "decisions-graph-vocabulary" },
		]);
	});

	test("running again after reopening the database is a no-op", () => {
		db.close();
		db = openDecisionsDb(dir);
		expect(migrate(db)).toEqual([]);
		expect(db.query("SELECT count(*) AS n FROM _migrations").get()).toEqual({
			n: 3,
		});
	});

	test("reports the migrations it applied to a fresh database", () => {
		const fresh = openDecisionsDb(mkdtempSync(join(tmpdir(), "cortex-fresh-")));
		try {
			expect(migrate(fresh)).toEqual([
				"decisions-schema",
				"decisions-present",
				"decisions-graph-vocabulary",
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

			expect(migrate(pre)).toEqual(["decisions-graph-vocabulary"]);
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
