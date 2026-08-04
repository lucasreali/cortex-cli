import type { Database } from "bun:sqlite";
import decisionsSchema from "./migrations/001-decisions-schema.sql" with {
	type: "text",
};
import codeSchema from "./migrations/002-code-schema.sql" with { type: "text" };
import codeMeta from "./migrations/003-code-meta.sql" with { type: "text" };
import decisionsPresent from "./migrations/004-decisions-present.sql" with {
	type: "text",
};

interface Migration {
	id: number;
	name: string;
	up(db: Database): void;
}

// Ids are per-list, filenames are numbered across both lists: each database
// file owns its own _migrations table, so decisions and code both start at 1.
const decisionsMigrations: Migration[] = [
	{
		id: 1,
		name: "decisions-schema",
		up: (db) => db.run(decisionsSchema),
	},
	{
		id: 2,
		name: "decisions-present",
		up: (db) => db.run(decisionsPresent),
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

// Returns the names applied by this call, so a caller can react to a store
// crossing a version boundary — the decision export needs to run exactly once,
// on the store that predates `.cortex/decisions/`.
export function migrate(db: Database): string[] {
	return applyAll(db, decisionsMigrations);
}

export function migrateCode(db: Database): string[] {
	return applyAll(db, codeMigrations);
}

function applyAll(db: Database, migrations: Migration[]): string[] {
	ensureMigrationsTable(db);
	return migrations.filter((migration) => applyOnce(db, migration)).map(named);
}

function named(migration: Migration): string {
	return migration.name;
}

function ensureMigrationsTable(db: Database): void {
	db.run(`CREATE TABLE IF NOT EXISTS _migrations (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	)`);
}

function applyOnce(db: Database, migration: Migration): boolean {
	const applied = db
		.query("SELECT 1 FROM _migrations WHERE id = ?")
		.get(migration.id);
	if (applied) return false;
	db.transaction(() => {
		migration.up(db);
		db.query("INSERT INTO _migrations (id, name) VALUES (?, ?)").run(
			migration.id,
			migration.name,
		);
	})();
	return true;
}
