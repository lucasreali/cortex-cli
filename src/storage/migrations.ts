import type { Database } from "bun:sqlite";
import decisionsSchema from "./migrations/001-decisions-schema.sql" with {
	type: "text",
};
import codeSchema from "./migrations/002-code-schema.sql" with { type: "text" };
import codeMeta from "./migrations/003-code-meta.sql" with { type: "text" };
import decisionsPresent from "./migrations/004-decisions-present.sql" with {
	type: "text",
};
import decisionsGraphVocabulary from "./migrations/005-decisions-graph-vocabulary.sql" with {
	type: "text",
};
import migrationsTable from "./migrations/migrations-table.sql" with {
	type: "text",
};

interface Migration {
	id: number;
	name: string;
	up(db: Database): void;
	// A migration that drops and recreates a referenced table needs foreign
	// keys off, and the pragma is a no-op inside a transaction — so the runner
	// toggles it around the transaction instead.
	rebuildsTables?: boolean;
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
	{
		id: 3,
		name: "decisions-graph-vocabulary",
		up: (db) => db.run(decisionsGraphVocabulary),
		rebuildsTables: true,
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
	db.run(migrationsTable);
}

function applyOnce(db: Database, migration: Migration): boolean {
	const applied = db
		.query("SELECT 1 FROM _migrations WHERE id = ?")
		.get(migration.id);
	if (applied) return false;
	if (migration.rebuildsTables) applyRebuilding(db, migration);
	else applyInTransaction(db, migration);
	return true;
}

function applyInTransaction(db: Database, migration: Migration): void {
	db.transaction(() => {
		migration.up(db);
		record(db, migration);
	})();
}

function applyRebuilding(db: Database, migration: Migration): void {
	db.run("PRAGMA foreign_keys = OFF");
	try {
		db.transaction(() => {
			migration.up(db);
			assertForeignKeysIntact(db, migration);
			record(db, migration);
		})();
	} finally {
		db.run("PRAGMA foreign_keys = ON");
	}
}

function assertForeignKeysIntact(db: Database, migration: Migration): void {
	const violations = db.query("PRAGMA foreign_key_check").all();
	if (violations.length === 0) return;
	throw new Error(
		`migration ${migration.name} left ${violations.length} foreign key violation(s)`,
	);
}

function record(db: Database, migration: Migration): void {
	db.query("INSERT INTO _migrations (id, name) VALUES (?, ?)").run(
		migration.id,
		migration.name,
	);
}
