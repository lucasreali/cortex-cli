import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeIndexer, computeDrift } from "@/indexer/code-indexer";
import { EXTRACTION_VERSION } from "@/indexer/extraction-version";
import { listSourceFiles } from "@/indexer/source-walker";
import { CodeRepository } from "@/storage/code-repository";
import { openCodeDb } from "@/storage/connection";
import { migrateCode } from "@/storage/migrations";

const FILE_COUNT = 50;

let dir: string;
let db: Database;
let repository: CodeRepository;
let indexer: CodeIndexer;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "cortex-code-indexer-"));
	mkdirSync(join(dir, ".cortex"));
	mkdirSync(join(dir, "src"));
	for (let position = 0; position < FILE_COUNT; position++) {
		writeFileSync(join(dir, "src", fileName(position)), fileContent(position));
	}
	db = openCodeDb(join(dir, ".cortex"));
	migrateCode(db);
	repository = new CodeRepository(db);
	indexer = await CodeIndexer.create(dir, repository);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function fileName(position: number): string {
	return `file${String(position).padStart(2, "0")}.ts`;
}

function fileContent(position: number): string {
	if (position === 0) return "export const value00 = () => 0;\n";
	const previous = String(position - 1).padStart(2, "0");
	return (
		`import { value${previous} } from "./file${previous}";\n` +
		`export const value${String(position).padStart(2, "0")} = () => value${previous}() + 1;\n`
	);
}

function bumpMtime(path: string): void {
	const future = new Date(Date.now() + 5000);
	utimesSync(join(dir, path), future, future);
}

describe("CodeIndexer", () => {
	test("first run indexes everything in full mode", async () => {
		const report = await indexer.run();

		expect(report).toEqual({
			mode: "full",
			indexed: FILE_COUNT,
			unchanged: 0,
			removed: 0,
		});
		expect(repository.listFiles()).toHaveLength(FILE_COUNT);
		expect(repository.symbolsIn("src/file07.ts")).toEqual([
			{ name: "value07", kind: "arrow", line: 2 },
		]);
		expect(repository.importsFrom("src/file07.ts")).toEqual([
			{
				specifier: "./file06",
				toPath: "src/file06.ts",
				provenance: "heuristic",
			},
		]);
	});

	test("an untouched tree reindexes nothing", async () => {
		await indexer.run();
		const report = await indexer.run();

		expect(report).toEqual({
			mode: "incremental",
			indexed: 0,
			unchanged: FILE_COUNT,
			removed: 0,
		});
	});

	test("editing 1 file out of 50 reindexes exactly 1", async () => {
		await indexer.run();
		writeFileSync(
			join(dir, "src/file10.ts"),
			`${fileContent(10)}export const extra10 = () => 99;\n`,
		);
		bumpMtime("src/file10.ts");

		const report = await indexer.run();

		expect(report).toEqual({
			mode: "incremental",
			indexed: 1,
			unchanged: FILE_COUNT - 1,
			removed: 0,
		});
		expect(repository.symbolsIn("src/file10.ts").map((s) => s.name)).toEqual([
			"value10",
			"extra10",
		]);
	});

	test("an mtime-only change refreshes metadata without reindexing", async () => {
		await indexer.run();
		const before = repository.getFile("src/file20.ts");
		bumpMtime("src/file20.ts");

		const report = await indexer.run();

		expect(report.indexed).toBe(0);
		expect(report.unchanged).toBe(FILE_COUNT);
		const after = repository.getFile("src/file20.ts");
		expect(after?.mtime).toBeGreaterThan(before?.mtime ?? 0);
		expect(after?.hash).toBe(before?.hash ?? "");
	});

	test("a deleted file is removed from the index", async () => {
		await indexer.run();
		rmSync(join(dir, "src/file30.ts"));

		const report = await indexer.run();

		expect(report.removed).toBe(1);
		expect(repository.getFile("src/file30.ts")).toBeNull();
	});

	test("a new file is indexed incrementally", async () => {
		await indexer.run();
		writeFileSync(join(dir, "src/fresh.ts"), "export const fresh = true;\n");

		const report = await indexer.run();

		expect(report.indexed).toBe(1);
		expect(repository.getFile("src/fresh.ts")).not.toBeNull();
	});

	test("a full index stamps the current extraction version", async () => {
		await indexer.run();
		expect(repository.extractionVersion()).toBe(EXTRACTION_VERSION);
	});

	test("a stale extraction stamp forces a full rebuild", async () => {
		await indexer.run();
		repository.stampExtractionVersion(EXTRACTION_VERSION - 1);

		const report = await indexer.run();

		expect(report.mode).toBe("full");
		expect(report.indexed).toBe(FILE_COUNT);
		expect(repository.extractionVersion()).toBe(EXTRACTION_VERSION);
	});

	test("an unstamped populated index forces a full rebuild", async () => {
		await indexer.run();
		db.query("DELETE FROM meta WHERE key = 'extraction_version'").run();

		const report = await indexer.run();

		expect(report.mode).toBe("full");
	});

	test("force always rebuilds from scratch", async () => {
		await indexer.run();
		const report = await indexer.run({ force: true });

		expect(report.mode).toBe("full");
		expect(report.indexed).toBe(FILE_COUNT);
	});

	test("computeDrift reports added, changed and removed without mutating", async () => {
		await indexer.run();
		writeFileSync(join(dir, "src/fresh.ts"), "export const fresh = () => 1;\n");
		writeFileSync(
			join(dir, "src/file05.ts"),
			`${fileContent(5)}export const more05 = () => 5;\n`,
		);
		bumpMtime("src/file05.ts");
		rmSync(join(dir, "src/file40.ts"));

		const drift = computeDrift(listSourceFiles(dir), repository.listFiles());

		expect(drift).toEqual({ added: 1, changed: 1, removed: 1 });
		expect(repository.listFiles()).toHaveLength(FILE_COUNT);
	});
});
