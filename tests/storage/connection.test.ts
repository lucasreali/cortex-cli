import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb, openDecisionsDbReadOnly } from "@/storage/connection";
import { migrate } from "@/storage/migrations";

let cortexDir: string;

beforeEach(() => {
	cortexDir = mkdtempSync(join(tmpdir(), "cortex-connection-"));
	const db = openDecisionsDb(cortexDir);
	migrate(db);
	db.close();
});

afterEach(() => {
	rmSync(cortexDir, { recursive: true, force: true });
});

function pragma(
	db: { query: (sql: string) => { get: () => unknown } },
	name: string,
) {
	return db.query(`PRAGMA ${name}`).get();
}

describe("decisions database connections", () => {
	// The MCP server serves other tool calls while a query waits, and
	// bun:sqlite blocks the event loop for the whole busy timeout.
	test("the busy timeout is the caller's choice, with a default", () => {
		const tuned = openDecisionsDb(cortexDir, { busyTimeoutMs: 250 });
		const standard = openDecisionsDb(cortexDir);
		try {
			expect(pragma(tuned, "busy_timeout")).toEqual({ timeout: 250 });
			expect(pragma(standard, "busy_timeout")).toEqual({ timeout: 5000 });
		} finally {
			tuned.close();
			standard.close();
		}
	});

	test("a read-only connection refuses writes", () => {
		const db = openDecisionsDbReadOnly(cortexDir);
		try {
			expect(() => db.run("DELETE FROM _migrations")).toThrow();
		} finally {
			db.close();
		}
	});

	test("a read-only connection leaves the directory as it found it", () => {
		const before = readdirSync(cortexDir).sort();

		const db = openDecisionsDbReadOnly(cortexDir);
		db.query("SELECT COUNT(*) FROM _migrations").get();
		db.close();

		expect(readdirSync(cortexDir).sort()).toEqual(before);
	});

	test("a read-only connection never creates the store it was pointed at", () => {
		const empty = mkdtempSync(join(tmpdir(), "cortex-connection-empty-"));
		try {
			expect(() => openDecisionsDbReadOnly(empty)).toThrow();
			expect(readdirSync(empty)).toEqual([]);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});
