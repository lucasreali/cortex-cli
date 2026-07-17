import type { Database } from "bun:sqlite";
import decisionsSchema from "./migrations/001-decisions-schema.sql" with {
	type: "text",
};

interface Migration {
	id: number;
	name: string;
	up(db: Database): void;
}

const migrations: Migration[] = [
	{
		id: 1,
		name: "decisions-schema",
		up: (db) => db.run(decisionsSchema),
	},
];

export function migrate(db: Database): void {
	ensureMigrationsTable(db);
	for (const migration of migrations) {
		applyOnce(db, migration);
	}
}

function ensureMigrationsTable(db: Database): void {
	db.run(`CREATE TABLE IF NOT EXISTS _migrations (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	)`);
}

function applyOnce(db: Database, migration: Migration): void {
	const applied = db
		.query("SELECT 1 FROM _migrations WHERE id = ?")
		.get(migration.id);
	if (applied) return;
	db.transaction(() => {
		migration.up(db);
		db.query("INSERT INTO _migrations (id, name) VALUES (?, ?)").run(
			migration.id,
			migration.name,
		);
	})();
}
