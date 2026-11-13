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
import decisionsProjectIdentity from "./migrations/006-decisions-project-identity.sql" with {
	type: "text",
};
import codeFileFacts from "./migrations/007-code-file-facts.sql" with {
	type: "text",
};
import decisionsNoSelfEdges from "./migrations/008-decisions-no-self-edges.sql" with {
	type: "text",
};
import decisionsContentSha from "./migrations/009-decisions-content-sha.sql" with {
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
	{
		id: 4,
		name: "decisions-project-identity",
		up: (db) => db.run(decisionsProjectIdentity),
	},
	{
		id: 5,
		name: "decisions-no-self-edges",
		up: (db) => db.run(decisionsNoSelfEdges),
		rebuildsTables: true,
	},
	{
		id: 6,
		name: "decisions-content-sha",
		up: (db) => db.run(decisionsContentSha),
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
	{
		id: 3,
		name: "code-file-facts",
		up: (db) => db.run(codeFileFacts),
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
	return applyAll(db, decisionsMigrations, "decisions.db");
}

export function migrateCode(db: Database): string[] {
	return applyAll(db, codeMigrations, "code.db");
}

function applyAll(
	db: Database,
	migrations: Migration[],
	store: string,
): string[] {
	ensureMigrationsTable(db);
	assertKnownSchema(db, migrations, store);
	return migrations.filter((migration) => applyOnce(db, migration)).map(named);
}

// An older binary must never write to a schema it does not know. Every
// migration so far only widened a CHECK, so the damage would be silent — rows
// this binary cannot represent, read back through columns it never saw — and
// doctor's warning does not stop `log`, `search`, `save_decision` or the git
// hook from writing meanwhile. Refusing costs one query and names the fix.
function assertKnownSchema(
	db: Database,
	migrations: Migration[],
	store: string,
): void {
	const known = migrations[migrations.length - 1]?.id ?? 0;
	const applied =
		db
			.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM _migrations")
			.get()?.id ?? 0;
	if (applied <= known) return;
	throw new Error(
		`${store} is at schema v${applied}, newer than the v${known} this cortex ` +
			"knows — run: cortex upgrade",
	);
}

function named(migration: Migration): string {
	return migration.name;
}

function ensureMigrationsTable(db: Database): void {
	db.run(migrationsTable);
}

function applyOnce(db: Database, migration: Migration): boolean {
	if (isApplied(db, migration)) return false;
	if (migration.rebuildsTables) {
		return withForeignKeysOff(db, () => applyExclusively(db, migration));
	}
	return applyExclusively(db, migration);
}

function isApplied(db: Database, migration: Migration): boolean {
	return (
		db.query("SELECT 1 FROM _migrations WHERE id = ?").get(migration.id) !==
		null
	);
}

// The check above is a shortcut; this one decides. The question and the write
// that answers it have to be the same transaction, and it has to be BEGIN
// IMMEDIATE: a deferred transaction takes no write lock until its first write,
// so on a fresh store two processes both read "not applied" and the loser then
// runs DDL that is no longer valid — an ordinary first command in a fresh
// clone, where the MCP server, a CLI invocation and the post-commit hook all
// migrate. With the lock taken up front busy_timeout makes the loser wait, and
// the re-check inside is what makes it correctly do nothing.
function applyExclusively(db: Database, migration: Migration): boolean {
	return db
		.transaction(() => {
			if (isApplied(db, migration)) return false;
			migration.up(db);
			if (migration.rebuildsTables) assertForeignKeysIntact(db, migration);
			record(db, migration);
			return true;
		})
		.immediate();
}

function withForeignKeysOff<T>(db: Database, body: () => T): T {
	db.run("PRAGMA foreign_keys = OFF");
	try {
		return body();
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
