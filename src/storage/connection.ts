import { Database } from "bun:sqlite";
import { join } from "node:path";
import { errnoCode } from "@/support/errors";

const WAL_RETRY_MS = 10;
const WAL_ATTEMPTS = 50;

export interface ConnectionOptions {
	busyTimeoutMs?: number;
}

// bun:sqlite is synchronous, so a busy wait blocks the whole event loop and
// not just the caller: a long timeout freezes an MCP server's transport while
// a git hook holds the write lock. Callers that serve other work concurrently
// pass a shorter one and surface the busy store instead of stalling.
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export function openDecisionsDb(
	cortexDir: string,
	options: ConnectionOptions = {},
): Database {
	return openDatabase(decisionsDbPath(cortexDir), options);
}

export function openCodeDb(
	cortexDir: string,
	options: ConnectionOptions = {},
): Database {
	return openDatabase(join(cortexDir, "code.db"), options);
}

// No create, no journal_mode change, no migration: every write this connection
// could make is a write to a project the caller was never asked to touch, and
// query_only makes SQLite itself refuse them.
//
// It is query_only rather than `readonly` because a read-only handle on a WAL
// database cannot clean up the -shm and -wal it opens, and leaving those behind
// is exactly the "this project gained files I never touched" the fan-out has to
// avoid. The cost is that a store on a read-only mount is reported as skipped.
export function openDecisionsDbReadOnly(
	cortexDir: string,
	options: ConnectionOptions = {},
): Database {
	const db = new Database(decisionsDbPath(cortexDir), {
		readwrite: true,
		create: false,
	});
	db.run("PRAGMA query_only = ON;");
	db.run(`PRAGMA busy_timeout = ${busyTimeout(options)};`);
	return db;
}

function decisionsDbPath(cortexDir: string): string {
	return join(cortexDir, "decisions.db");
}

// A file that is not a database fails on the first pragma, not on open, so the
// handle has to be released here — a caller that retries a corrupt store would
// otherwise climb to its descriptor limit one attempt at a time.
function openDatabase(path: string, options: ConnectionOptions): Database {
	const db = new Database(path, { create: true });
	try {
		// busy_timeout first: everything after it may need a lock, and until it is
		// set SQLite gives up the instant one is held.
		db.run(`PRAGMA busy_timeout = ${busyTimeout(options)};`);
		enableWal(db);
		db.run("PRAGMA foreign_keys = ON;");
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

function busyTimeout(options: ConnectionOptions): number {
	return options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
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
