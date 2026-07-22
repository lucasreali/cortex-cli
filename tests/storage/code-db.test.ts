import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileIndexEntry } from "@/domain";
import { CodeRepository } from "@/storage/code-repository";
import { openCodeDb } from "@/storage/connection";
import { migrateCode } from "@/storage/migrations";

let dir: string;
let db: Database;
let repository: CodeRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-code-db-"));
	db = openCodeDb(dir);
	migrateCode(db);
	repository = new CodeRepository(db);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function schemaNames(type: "table" | "index"): string[] {
	return db
		.query<{ name: string }, [string]>(
			"SELECT name FROM sqlite_master WHERE type = ?",
		)
		.all(type)
		.map((row) => row.name);
}

function entryFixture(overrides: Partial<FileIndexEntry> = {}): FileIndexEntry {
	return {
		file: {
			path: "src/auth/service.ts",
			lang: "ts",
			hash: "abc123",
			mtime: 1700000000,
			size: 2048,
		},
		symbols: [
			{ name: "AuthService", kind: "class", line: 3 },
			{ name: "AuthService.validateToken", kind: "method", line: 10 },
		],
		imports: [
			{
				specifier: "./token.ts",
				toPath: "src/auth/token.ts",
				provenance: "exact",
			},
			{ specifier: "zod", toPath: null, provenance: "heuristic" },
		],
		...overrides,
	};
}

function importerFixture(): FileIndexEntry {
	return {
		file: {
			path: "src/api/login.ts",
			lang: "ts",
			hash: "def456",
			mtime: 1700000100,
			size: 512,
		},
		symbols: [{ name: "login", kind: "function", line: 5 }],
		imports: [
			{
				specifier: "../auth/service",
				toPath: "src/auth/service.ts",
				provenance: "heuristic",
			},
		],
	};
}

function snapshot(repo: CodeRepository) {
	return repo.listFiles().map((file) => ({
		file,
		symbols: repo.symbolsIn(file.path),
		imports: repo.importsFrom(file.path),
	}));
}

describe("code.db connection", () => {
	test("applies WAL, foreign_keys and busy_timeout pragmas", () => {
		expect(db.query("PRAGMA journal_mode").get()).toEqual({
			journal_mode: "wal",
		});
		expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
		expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
	});
});

describe("code.db migrations", () => {
	test("running twice on the same connection is a no-op", () => {
		migrateCode(db);
		const rows = db.query("SELECT id, name FROM _migrations").all();
		expect(rows).toEqual([{ id: 1, name: "code-schema" }]);
	});

	test("running again after reopening the database is a no-op", () => {
		db.close();
		db = openCodeDb(dir);
		migrateCode(db);
		expect(db.query("SELECT count(*) AS n FROM _migrations").get()).toEqual({
			n: 1,
		});
	});

	test("creates the code.db tables", () => {
		const tables = schemaNames("table");
		for (const table of ["files", "symbols", "imports", "_migrations"]) {
			expect(tables).toContain(table);
		}
	});

	test("creates the indexes", () => {
		const indexes = schemaNames("index");
		expect(indexes).toContain("idx_symbols_name");
		expect(indexes).toContain("idx_symbols_file");
		expect(indexes).toContain("idx_imports_to");
	});

	test("imports.provenance defaults to heuristic", () => {
		db.query(
			"INSERT INTO imports (from_path, specifier) VALUES ('src/a.ts', './b')",
		).run();
		expect(db.query("SELECT provenance FROM imports").get()).toEqual({
			provenance: "heuristic",
		});
	});

	test("imports are unique per (from_path, specifier)", () => {
		db.query(
			"INSERT INTO imports (from_path, specifier) VALUES ('src/a.ts', './b')",
		).run();
		expect(() =>
			db
				.query(
					"INSERT INTO imports (from_path, specifier) VALUES ('src/a.ts', './b')",
				)
				.run(),
		).toThrow();
	});

	test("symbols require an existing file", () => {
		expect(() =>
			db
				.query(
					"INSERT INTO symbols (file_path, name, kind, line) VALUES ('ghost.ts', 'f', 'function', 1)",
				)
				.run(),
		).toThrow();
	});
});

function chainEntry(
	path: string,
	imports: FileIndexEntry["imports"],
): FileIndexEntry {
	return {
		file: { path, lang: "ts", hash: `h-${path}`, mtime: 1, size: 10 },
		symbols: [],
		imports,
	};
}

describe("CodeRepository.transitiveImporters", () => {
	beforeEach(() => {
		repository.wipeAndRebuild([
			chainEntry("src/core.ts", [
				{ specifier: "./loop", toPath: "src/loop.ts", provenance: "exact" },
			]),
			chainEntry("src/mid.ts", [
				{ specifier: "./core.ts", toPath: "src/core.ts", provenance: "exact" },
			]),
			chainEntry("src/top.ts", [
				{ specifier: "./mid", toPath: "src/mid.ts", provenance: "heuristic" },
			]),
			chainEntry("src/loop.ts", [
				{ specifier: "./top.ts", toPath: "src/top.ts", provenance: "exact" },
			]),
		]);
	});

	test("walks importers transitively, chaining provenance pessimistically", () => {
		expect(repository.transitiveImporters(["src/core.ts"], 5)).toEqual([
			{ path: "src/mid.ts", depth: 1, provenance: "exact" },
			{ path: "src/top.ts", depth: 2, provenance: "heuristic" },
			{ path: "src/loop.ts", depth: 3, provenance: "heuristic" },
		]);
	});

	test("respects maxDepth", () => {
		expect(repository.transitiveImporters(["src/core.ts"], 1)).toEqual([
			{ path: "src/mid.ts", depth: 1, provenance: "exact" },
		]);
	});

	test("cycles terminate and seeds never appear in the result", () => {
		const importers = repository.transitiveImporters(["src/core.ts"], 10);
		expect(importers.map((importer) => importer.path)).not.toContain(
			"src/core.ts",
		);
	});

	test("multiple seeds merge at the shortest depth", () => {
		expect(
			repository.transitiveImporters(["src/core.ts", "src/mid.ts"], 5),
		).toEqual([
			{ path: "src/top.ts", depth: 1, provenance: "heuristic" },
			{ path: "src/loop.ts", depth: 2, provenance: "heuristic" },
		]);
	});
});

describe("CodeRepository symbol lookups", () => {
	beforeEach(() => {
		repository.wipeAndRebuild([entryFixture(), importerFixture()]);
	});

	test("hasSymbol checks the exact name within a file", () => {
		expect(
			repository.hasSymbol("src/auth/service.ts", "AuthService.validateToken"),
		).toBe(true);
		expect(repository.hasSymbol("src/auth/service.ts", "login")).toBe(false);
	});

	test("findSymbol locates a qualified name across files", () => {
		expect(repository.findSymbol("AuthService.validateToken")).toEqual([
			{ filePath: "src/auth/service.ts", kind: "method", line: 10 },
		]);
		expect(repository.findSymbol("Ghost.method")).toEqual([]);
	});

	test("suggestSymbols prefers same-file matches via the owner prefix", () => {
		expect(
			repository.suggestSymbols("src/auth/service.ts", "AuthService.login", 3),
		).toEqual(["AuthService.validateToken"]);
	});

	test("suggestSymbols falls back to a global substring match", () => {
		expect(repository.suggestSymbols("src/ghost.ts", "login", 3)).toEqual([
			"login",
		]);
	});
});

describe("CodeRepository", () => {
	test("wipeAndRebuild populates files, symbols and imports", () => {
		repository.wipeAndRebuild([entryFixture(), importerFixture()]);

		expect(repository.listFiles().map((file) => file.path)).toEqual([
			"src/api/login.ts",
			"src/auth/service.ts",
		]);
		expect(repository.symbolsIn("src/auth/service.ts")).toEqual([
			{ name: "AuthService", kind: "class", line: 3 },
			{ name: "AuthService.validateToken", kind: "method", line: 10 },
		]);
		expect(repository.importsFrom("src/auth/service.ts")).toEqual([
			{
				specifier: "./token.ts",
				toPath: "src/auth/token.ts",
				provenance: "exact",
			},
			{ specifier: "zod", toPath: null, provenance: "heuristic" },
		]);
	});

	test("wipeAndRebuild discards everything previously stored", () => {
		repository.wipeAndRebuild([entryFixture(), importerFixture()]);
		repository.wipeAndRebuild([importerFixture()]);

		expect(repository.listFiles().map((file) => file.path)).toEqual([
			"src/api/login.ts",
		]);
		expect(repository.symbolsIn("src/auth/service.ts")).toEqual([]);
		expect(repository.importsFrom("src/auth/service.ts")).toEqual([]);
	});

	test("getFile returns the stored row or null", () => {
		repository.wipeAndRebuild([entryFixture()]);

		expect(repository.getFile("src/auth/service.ts")).toEqual({
			path: "src/auth/service.ts",
			lang: "ts",
			hash: "abc123",
			mtime: 1700000000,
			size: 2048,
		});
		expect(repository.getFile("ghost.ts")).toBeNull();
	});

	test("upsertFile adds a new file", () => {
		repository.wipeAndRebuild([entryFixture()]);
		repository.upsertFile(importerFixture());

		expect(repository.listFiles()).toHaveLength(2);
		expect(repository.symbolsIn("src/api/login.ts")).toEqual([
			{ name: "login", kind: "function", line: 5 },
		]);
	});

	test("upsertFile replaces an existing file without duplicating rows", () => {
		repository.wipeAndRebuild([entryFixture()]);

		const edited = entryFixture({
			symbols: [{ name: "AuthService", kind: "class", line: 4 }],
			imports: [
				{
					specifier: "./jwt.ts",
					toPath: "src/auth/jwt.ts",
					provenance: "exact",
				},
			],
		});
		edited.file.hash = "changed";
		repository.upsertFile(edited);

		expect(repository.getFile("src/auth/service.ts")?.hash).toBe("changed");
		expect(repository.symbolsIn("src/auth/service.ts")).toEqual([
			{ name: "AuthService", kind: "class", line: 4 },
		]);
		expect(repository.importsFrom("src/auth/service.ts")).toEqual([
			{ specifier: "./jwt.ts", toPath: "src/auth/jwt.ts", provenance: "exact" },
		]);
	});

	test("listImports returns every import row ordered", () => {
		repository.wipeAndRebuild([entryFixture(), importerFixture()]);

		expect(repository.listImports()).toEqual([
			{
				fromPath: "src/api/login.ts",
				specifier: "../auth/service",
				toPath: "src/auth/service.ts",
			},
			{
				fromPath: "src/auth/service.ts",
				specifier: "./token.ts",
				toPath: "src/auth/token.ts",
			},
			{ fromPath: "src/auth/service.ts", specifier: "zod", toPath: null },
		]);
	});

	test("touchFile refreshes metadata and keeps symbols and imports", () => {
		repository.wipeAndRebuild([entryFixture()]);
		repository.touchFile({
			path: "src/auth/service.ts",
			lang: "ts",
			hash: "abc123",
			mtime: 1700009999,
			size: 2048,
		});

		expect(repository.getFile("src/auth/service.ts")?.mtime).toBe(1700009999);
		expect(repository.symbolsIn("src/auth/service.ts")).toHaveLength(2);
		expect(repository.importsFrom("src/auth/service.ts")).toHaveLength(2);
	});

	test("removeFile deletes the file with its symbols and imports", () => {
		repository.wipeAndRebuild([entryFixture(), importerFixture()]);
		repository.removeFile("src/auth/service.ts");

		expect(repository.getFile("src/auth/service.ts")).toBeNull();
		expect(repository.symbolsIn("src/auth/service.ts")).toEqual([]);
		expect(repository.importsFrom("src/auth/service.ts")).toEqual([]);
		expect(repository.getFile("src/api/login.ts")).not.toBeNull();
	});

	test("deleting code.db and reindexing produces an identical result", () => {
		repository.wipeAndRebuild([entryFixture()]);
		repository.upsertFile(importerFixture());
		repository.upsertFile(entryFixture({ symbols: [] }));
		repository.removeFile("src/auth/service.ts");
		repository.upsertFile(entryFixture());
		const before = snapshot(repository);

		db.close();
		for (const suffix of ["", "-wal", "-shm"]) {
			rmSync(join(dir, `code.db${suffix}`), { force: true });
		}
		db = openCodeDb(dir);
		migrateCode(db);
		repository = new CodeRepository(db);
		repository.wipeAndRebuild([entryFixture(), importerFixture()]);

		expect(snapshot(repository)).toEqual(before);
	});
});
