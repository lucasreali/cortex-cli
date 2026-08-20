// Opens one store and migrates it, printing how many migrations this process
// applied. The race it exists to exercise is between processes — in a single
// one the runner is synchronous and never interleaves — so the test spawns
// several of these at the same directory at once.
// Usage: bun migrate-racer.ts <store-dir>
import { openDecisionsDb } from "@/storage/connection";
import { migrate } from "@/storage/migrations";

const dir = process.argv[2];
if (!dir) throw new Error("usage: migrate-racer.ts <store-dir>");

const db = openDecisionsDb(dir);
try {
	console.log(`applied:${migrate(db).length}`);
} finally {
	db.close();
}
