import { Database } from "bun:sqlite";
import { join } from "node:path";
import { errnoCode } from "@/support/errors";

const BUSY_TIMEOUT_MS = 5000;
const WAL_RETRY_MS = 10;
const WAL_ATTEMPTS = 50;

export function openDecisionsDb(cortexDir: string): Database {
	return openDatabase(join(cortexDir, "decisions.db"));
}

export function openCodeDb(cortexDir: string): Database {
	return openDatabase(join(cortexDir, "code.db"));
}

function openDatabase(path: string): Database {
	const db = new Database(path, { create: true });
	// busy_timeout first: everything after it may need a lock, and until it is
	// set SQLite gives up the instant one is held.
	db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
	enableWal(db);
	db.run("PRAGMA foreign_keys = ON;");
	return db;
}

// The journal mode belongs to the file, not the connection, so the first
// process to reach a fresh store sets it once and every later one only reads
// it back. The switch takes the database exclusively and SQLite does not run
// the busy handler for it, so busy_timeout cannot help: without a retry, the
// processes that meet on a fresh store — the MCP server, a CLI invocation, the
// post-commit hook — lose that race with "database is locked" before a single
// migration has had the chance to run.
function enableWal(db: Database): void {
	for (let attempt = 1; attempt < WAL_ATTEMPTS; attempt++) {
		if (journalMode(db) === "wal") return;
		if (switchedToWal(db)) return;
		Bun.sleepSync(WAL_RETRY_MS);
	}
	switchToWal(db);
}

function journalMode(db: Database): string | undefined {
	return db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()
		?.journal_mode;
}

function switchedToWal(db: Database): boolean {
	try {
		switchToWal(db);
		return true;
	} catch (error) {
		if (errnoCode(error) !== "SQLITE_BUSY") throw error;
		return false;
	}
}

function switchToWal(db: Database): void {
	db.run("PRAGMA journal_mode = WAL;");
}
