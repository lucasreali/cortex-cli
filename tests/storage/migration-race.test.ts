import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "@/storage/connection";
import { SCHEMA_VERSION } from "@/storage/migrations";

const RACER_PATH = new URL("../fixtures/migrate-racer.ts", import.meta.url)
	.pathname;

const STORES = 3;
const RACERS_PER_STORE = 3;

interface Run {
	dir: string;
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function raceOverFreshStores(): Promise<Run[]> {
	const dirs = Array.from({ length: STORES }, () =>
		mkdtempSync(join(tmpdir(), "cortex-migration-race-")),
	);
	const spawned = dirs.flatMap((dir) =>
		Array.from({ length: RACERS_PER_STORE }, () => ({
			dir,
			child: Bun.spawn(["bun", RACER_PATH, dir], {
				stdout: "pipe",
				stderr: "pipe",
			}),
		})),
	);
	return await Promise.all(
		spawned.map(async ({ dir, child }) => ({
			dir,
			exitCode: await child.exited,
			stdout: await new Response(child.stdout).text(),
			stderr: await new Response(child.stderr).text(),
		})),
	);
}

function totalApplied(runs: Run[], dir: string): number {
	return runs
		.filter((run) => run.dir === dir)
		.reduce(
			(total, run) => total + Number(run.stdout.replace("applied:", "")),
			0,
		);
}

describe("concurrent first use of a fresh store", () => {
	// The failure this pins is not a lost update but a crash: the loser used to
	// run DDL the winner had already run, and 16 of 36 runs died on "index
	// idx_nodes_kind_status already exists", "UNIQUE constraint failed:
	// _migrations.id" or "database is locked".
	// Which process applies which migration is not fixed — the loser of one may
	// win the next — but no migration may run twice and none may be skipped, so
	// the counts add up to the schema exactly once per store.
	test("every process succeeds and each migration is applied once", async () => {
		const runs = await raceOverFreshStores();
		const dirs = [...new Set(runs.map((run) => run.dir))];
		try {
			for (const run of runs) {
				expect({ code: run.exitCode, err: run.stderr }).toEqual({
					code: 0,
					err: "",
				});
			}
			for (const dir of dirs) {
				expect(totalApplied(runs, dir)).toBe(SCHEMA_VERSION);
				const db = openDecisionsDb(dir);
				expect(db.query("SELECT count(*) AS n FROM _migrations").get()).toEqual(
					{ n: SCHEMA_VERSION },
				);
				db.close();
			}
		} finally {
			for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
