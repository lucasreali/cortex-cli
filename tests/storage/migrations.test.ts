import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "@/storage/connection";
import { migrate } from "@/storage/migrations";

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
		]);
	});

	test("running again after reopening the database is a no-op", () => {
		db.close();
		db = openDecisionsDb(dir);
		expect(migrate(db)).toEqual([]);
		expect(db.query("SELECT count(*) AS n FROM _migrations").get()).toEqual({
			n: 2,
		});
	});

	test("reports the migrations it applied to a fresh database", () => {
		const fresh = openDecisionsDb(mkdtempSync(join(tmpdir(), "cortex-fresh-")));
		try {
			expect(migrate(fresh)).toEqual(["decisions-schema", "decisions-present"]);
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
