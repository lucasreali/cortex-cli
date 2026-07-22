import type { Database } from "bun:sqlite";
import decisionsSchema from "./migrations/001-decisions-schema.sql" with {
	type: "text",
};
import codeSchema from "./migrations/002-code-schema.sql" with { type: "text" };
import codeMeta from "./migrations/003-code-meta.sql" with { type: "text" };

interface Migration {
	id: number;
	name: string;
	up(db: Database): void;
}

const decisionsMigrations: Migration[] = [
	{
		id: 1,
		name: "decisions-schema",
		up: (db) => db.run(decisionsSchema),
	},
];

const codeMigrations: Migration[] = [
	{
		id: 1,
		name: "code-schema",
		up: (db) => db.run(codeSchema),
	},
	{
		id: 2,
		name: "code-meta",
		up: (db) => db.run(codeMeta),
	},
];

export const SCHEMA_VERSION =
	decisionsMigrations[decisionsMigrations.length - 1]?.id ?? 0;

export const CODE_SCHEMA_VERSION =
	codeMigrations[codeMigrations.length - 1]?.id ?? 0;

export function migrate(db: Database): void {
	applyAll(db, decisionsMigrations);
}

export function migrateCode(db: Database): void {
	applyAll(db, codeMigrations);
}

function applyAll(db: Database, migrations: Migration[]): void {
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
