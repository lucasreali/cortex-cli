import { Database } from "bun:sqlite";
import { join } from "node:path";

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
		db.run("PRAGMA journal_mode = WAL;");
		db.run("PRAGMA foreign_keys = ON;");
		db.run(`PRAGMA busy_timeout = ${busyTimeout(options)};`);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

function busyTimeout(options: ConnectionOptions): number {
	return options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
}
