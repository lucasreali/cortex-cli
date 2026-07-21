import { Database } from "bun:sqlite";
import { join } from "node:path";

export function openDecisionsDb(cortexDir: string): Database {
	return openDatabase(join(cortexDir, "decisions.db"));
}

export function openCodeDb(cortexDir: string): Database {
	return openDatabase(join(cortexDir, "code.db"));
}

function openDatabase(path: string): Database {
	const db = new Database(path, { create: true });
	db.run("PRAGMA journal_mode = WAL;");
	db.run("PRAGMA foreign_keys = ON;");
	db.run("PRAGMA busy_timeout = 5000;");
	return db;
}
