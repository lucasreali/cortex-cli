import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CodeIndexer,
	computeDrift,
	danglingTargets,
} from "@/indexer/code-indexer";
import { EXTRACTION_VERSION } from "@/indexer/extraction-version";
import { listSources } from "@/indexer/source-walker";
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

function oversizedSource(): Buffer {
	return Buffer.alloc(1024 * 1024 + 1, 0x20);
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
			repaired: 0,
			skipped: [],
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
			repaired: 0,
			skipped: [],
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
			repaired: 0,
			skipped: [],
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

	// The listing is taken synchronously at the top of run(), so deleting a file
	// after the call and before the await is the ordinary race against a
	// checkout or an editor save — one file, not a failed index.
	test("a file that vanishes mid-run is skipped, not fatal", async () => {
		const running = indexer.run();
		rmSync(join(dir, "src/file25.ts"));

		const report = await running;

		expect(report.indexed).toBe(FILE_COUNT - 1);
		expect(report.skipped.map((entry) => entry.path)).toEqual([
			"src/file25.ts",
		]);
		expect(repository.listFiles()).toHaveLength(FILE_COUNT - 1);
	});

	test("a symlink cycle is skipped and the rest of the tree is indexed", async () => {
		symlinkSync("cycle.ts", join(dir, "src/cycle.ts"));

		const report = await indexer.run();

		expect(report.indexed).toBe(FILE_COUNT);
		expect(report.skipped.map((entry) => entry.path)).toEqual(["src/cycle.ts"]);
	});

	// A file the pass could not read is not a file that left the tree, so
	// pruning its rows would drop symbols over a transient permission error.
	test("an unreadable file keeps the rows it already had", async () => {
		await indexer.run();
		rmSync(join(dir, "src/file15.ts"));
		symlinkSync("file15.ts", join(dir, "src/file15.ts"));

		const report = await indexer.run();

		expect(report.removed).toBe(0);
		expect(repository.getFile("src/file15.ts")).not.toBeNull();
		expect(report.skipped.map((entry) => entry.path)).toEqual([
			"src/file15.ts",
		]);
	});

	test("an oversized file resolves as an import target without being parsed", async () => {
		writeFileSync(join(dir, "src/schema.ts"), oversizedSource());
		writeFileSync(
			join(dir, "src/uses-schema.ts"),
			'import { Schema } from "./schema";\nexport const use = () => Schema;\n',
		);

		const report = await indexer.run();

		expect(repository.importsFrom("src/uses-schema.ts")).toEqual([
			{
				specifier: "./schema",
				toPath: "src/schema.ts",
				provenance: "heuristic",
			},
		]);
		expect(repository.getFile("src/schema.ts")).toBeNull();
		expect(report.skipped.map((entry) => entry.path)).toEqual([
			"src/schema.ts",
		]);
	});

	test("a binary blob with a source extension is recorded but never parsed", async () => {
		writeFileSync(join(dir, "src/blob.ts"), Buffer.from([0x01, 0x00, 0x02]));

		const report = await indexer.run();

		expect(report.skipped).toEqual([
			{ path: "src/blob.ts", reason: "binary content, not source text" },
		]);
		expect(repository.symbolsIn("src/blob.ts")).toEqual([]);
		expect(repository.getFile("src/blob.ts")).not.toBeNull();
	});

	// Skipped files are invisible to the index, so counting them as drift would
	// make doctor demand a reindex that can never settle.
	test("computeDrift ignores what the pass skipped", async () => {
		writeFileSync(join(dir, "src/schema.ts"), oversizedSource());
		await indexer.run();
		rmSync(join(dir, "src/file35.ts"));
		symlinkSync("file35.ts", join(dir, "src/file35.ts"));

		const drift = computeDrift(listSources(dir), repository.listFiles());

		expect(drift).toEqual({ added: 0, changed: 0, removed: 0 });
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

		const drift = computeDrift(listSources(dir), repository.listFiles());

		expect(drift).toEqual({ added: 1, changed: 1, removed: 1 });
		expect(repository.listFiles()).toHaveLength(FILE_COUNT);
	});
});

// H8: an incremental pass rewrote rows only for files whose own bytes changed,
// but an import's target is a function of the whole file set. An edge resolved
// — or left NULL — at index time stayed frozen until its importer happened to
// change, so the common workflow (add a module, then move it) silently made
// get_impact answer "no code impact" with confidence, and doctor called the
// tree in sync because the importer really was unchanged.
describe("CodeIndexer edge repair", () => {
	function targetOf(
		from: string,
		specifier: string,
	): string | null | undefined {
		return repository
			.importsFrom(from)
			.find((entry) => entry.specifier === specifier)?.toPath;
	}

	test("an edge left NULL is repaired once its target lands", async () => {
		writeFileSync(
			join(dir, "src/c.ts"),
			'import { d } from "./d";\nexport const c = () => d;\n',
		);
		await indexer.run();
		expect(targetOf("src/c.ts", "./d")).toBeNull();

		writeFileSync(join(dir, "src/d.ts"), "export const d = 1;\n");
		const report = await indexer.run();

		expect(targetOf("src/c.ts", "./d")).toBe("src/d.ts");
		expect(report.repaired).toBe(1);
	});

	test("renaming a module re-points every edge into it", async () => {
		writeFileSync(join(dir, "src/util.ts"), "export const u = 1;\n");
		writeFileSync(
			join(dir, "src/main.ts"),
			'import { u } from "./util";\nexport const m = () => u;\n',
		);
		await indexer.run();
		expect(targetOf("src/main.ts", "./util")).toBe("src/util.ts");

		rmSync(join(dir, "src/util.ts"));
		writeFileSync(join(dir, "src/util.tsx"), "export const u = 1;\n");
		await indexer.run();

		expect(targetOf("src/main.ts", "./util")).toBe("src/util.tsx");
	});

	test("deleting a module leaves no edge pointing at it", async () => {
		writeFileSync(join(dir, "src/util.ts"), "export const u = 1;\n");
		writeFileSync(
			join(dir, "src/main.ts"),
			'import { u } from "./util";\nexport const m = () => u;\n',
		);
		await indexer.run();

		rmSync(join(dir, "src/util.ts"));
		await indexer.run();

		expect(targetOf("src/main.ts", "./util")).toBeNull();
		expect(danglingTargets(listSources(dir), repository.listImports())).toEqual(
			[],
		);
	});

	// The repair reads every edge, so it is paid only when the file set moved —
	// a re-check on an untouched tree stays a stat per file.
	test("an untouched tree repairs nothing", async () => {
		await indexer.run();

		const report = await indexer.run();

		expect(report.repaired).toBe(0);
	});

	test("danglingTargets names a target the working tree no longer has", async () => {
		writeFileSync(join(dir, "src/util.ts"), "export const u = 1;\n");
		writeFileSync(
			join(dir, "src/main.ts"),
			'import { u } from "./util";\nexport const m = () => u;\n',
		);
		await indexer.run();
		rmSync(join(dir, "src/util.ts"));

		expect(danglingTargets(listSources(dir), repository.listImports())).toEqual(
			["src/util.ts"],
		);
	});

	// An oversized file is deliberately a real import target with no `files`
	// row, so checking edges against the indexed set would report it forever.
	test("an oversized import target is not dangling", async () => {
		writeFileSync(join(dir, "src/schema.ts"), oversizedSource());
		writeFileSync(
			join(dir, "src/uses-schema.ts"),
			'import { Schema } from "./schema";\nexport const use = () => Schema;\n',
		);
		await indexer.run();

		expect(danglingTargets(listSources(dir), repository.listImports())).toEqual(
			[],
		);
	});
});

// M11: mtime and size are both forgeable by an ordinary restore — `cp -p`,
// `tar -x`, `rsync -t`, a CI cache restore — after which the index served
// symbols that no longer existed and doctor reported "in sync". An inode change
// time is the one half of the triple no userspace call can set.
describe("CodeIndexer staleness", () => {
	function rewritePreservingMtime(path: string, content: string): void {
		const absolute = join(dir, path);
		const before = statSync(absolute);
		writeFileSync(absolute, content);
		utimesSync(absolute, before.atime, before.mtime);
	}

	const RESTORED =
		'import { value19 } from "./file19";\nexport const value20 = () => value19() + 2;\n';

	test("content restored under the recorded mtime and size is reindexed", async () => {
		await indexer.run();
		const before = repository.getFile("src/file20.ts");
		expect(RESTORED.length).toBe(fileContent(20).length);

		rewritePreservingMtime("src/file20.ts", RESTORED);
		const report = await indexer.run();

		const after = repository.getFile("src/file20.ts");
		expect(after?.mtime).toBe(before?.mtime ?? -1);
		expect(after?.size).toBe(before?.size ?? -1);
		expect(after?.hash).not.toBe(before?.hash ?? "");
		expect(report.indexed).toBe(1);
	});

	test("doctor sees the same change as drift", async () => {
		await indexer.run();
		rewritePreservingMtime("src/file20.ts", RESTORED);

		expect(computeDrift(listSources(dir), repository.listFiles())).toEqual({
			added: 0,
			changed: 1,
			removed: 0,
		});
	});

	test("a file the grammar could not read is recorded as such", async () => {
		writeFileSync(join(dir, "src/broken.ts"), "export function broken( {\n");

		await indexer.run();

		expect(repository.getFile("src/broken.ts")?.hasError).toBe(true);
		expect(repository.getFile("src/file01.ts")?.hasError).toBe(false);
	});
});
