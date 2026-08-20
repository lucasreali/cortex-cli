import type { Database } from "bun:sqlite";
import type {
	CodeImport,
	CodeSymbol,
	FileIndexEntry,
	ImportProvenance,
	IndexedFile,
} from "@/domain";
import {
	canonicalSymbolName,
	symbolKey,
	symbolKeyParts,
} from "@/support/symbol-key";
import matchSymbolsSql from "./queries/match-symbols.sql" with { type: "text" };
import transitiveImportersSql from "./queries/transitive-importers.sql" with {
	type: "text",
};
import {
	type LocatedSymbolRow,
	type SymbolLocation,
	SymbolTable,
} from "./symbol-table";

export interface TransitiveImporter {
	path: string;
	depth: number;
	provenance: ImportProvenance;
}

const IMPORTERS_ROW_LIMIT = 5000;

interface FileRow {
	path: string;
	lang: string;
	hash: string;
	mtime: number;
	size: number;
}

interface SymbolRow {
	name: string;
	kind: string;
	line: number;
}

interface ImportRow {
	specifier: string;
	to_path: string | null;
	provenance: ImportProvenance;
}

export class CodeRepository {
	constructor(private readonly db: Database) {}

	wipeAndRebuild(entries: FileIndexEntry[]): void {
		this.db.transaction(() => {
			this.db.run("DELETE FROM imports");
			this.db.run("DELETE FROM symbols");
			this.db.run("DELETE FROM files");
			for (const entry of entries) {
				this.insertEntry(entry);
			}
		})();
	}

	upsertFile(entry: FileIndexEntry): void {
		this.db.transaction(() => {
			this.deleteFileRows(entry.file.path);
			this.insertEntry(entry);
		})();
	}

	removeFile(path: string): void {
		this.db.transaction(() => this.deleteFileRows(path))();
	}

	extractionVersion(): number | null {
		const row = this.db
			.query<{ value: string }, []>(
				"SELECT value FROM meta WHERE key = 'extraction_version'",
			)
			.get();
		if (!row) return null;
		const parsed = Number.parseInt(row.value, 10);
		return Number.isFinite(parsed) ? parsed : null;
	}

	stampExtractionVersion(version: number): void {
		this.db
			.query(
				`INSERT INTO meta (key, value) VALUES ('extraction_version', ?)
				 ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
			)
			.run(String(version));
	}

	touchFile(file: IndexedFile): void {
		this.db
			.query(
				"UPDATE files SET lang = ?, hash = ?, mtime = ?, size = ? WHERE path = ?",
			)
			.run(file.lang, file.hash, file.mtime, file.size, file.path);
	}

	getFile(path: string): IndexedFile | null {
		const row = this.db
			.query<FileRow, [string]>("SELECT * FROM files WHERE path = ?")
			.get(path);
		if (!row) return null;
		return row;
	}

	listFiles(): IndexedFile[] {
		return this.db
			.query<FileRow, []>("SELECT * FROM files ORDER BY path")
			.all();
	}

	symbolsIn(filePath: string): CodeSymbol[] {
		return this.db
			.query<SymbolRow, [string]>(
				`SELECT name, kind, line FROM symbols
				 WHERE file_path = ? ORDER BY line, name`,
			)
			.all(filePath);
	}

	transitiveImporters(
		seedPaths: string[],
		maxDepth: number,
	): TransitiveImporter[] {
		return this.db
			.query<
				{ path: string; depth: number; provenance: ImportProvenance },
				{ $seeds: string; $maxDepth: number; $limit: number }
			>(transitiveImportersSql)
			.all({
				$seeds: JSON.stringify(seedPaths),
				$maxDepth: maxDepth,
				$limit: IMPORTERS_ROW_LIMIT,
			});
	}

	// SQLite cannot run the normalizer, so the comparison happens here rather
	// than in a WHERE clause: file_path is indexed, which keeps the row set one
	// file wide, and the alternative — a second stored column holding the key —
	// buys speed this store does not need at the cost of a schema that can
	// disagree with the recipe.
	hasSymbol(filePath: string, name: string): boolean {
		const wanted = symbolKey(name);
		return this.db
			.query<{ name: string }, [string]>(
				"SELECT name FROM symbols WHERE file_path = ?",
			)
			.all(filePath)
			.some((row) => symbolKey(row.name) === wanted);
	}

	// One scan answers every name, so a caller with more than one to look up
	// reads the table once and keeps it.
	symbolTable(): SymbolTable {
		return new SymbolTable(
			this.db
				.query<LocatedSymbolRow, []>(
					"SELECT file_path, kind, line, name FROM symbols ORDER BY file_path, line",
				)
				.all(),
		);
	}

	findSymbol(name: string): SymbolLocation[] {
		return this.symbolTable().locationsOf(name);
	}

	suggestSymbols(filePath: string, name: string, limit: number): string[] {
		const local = this.matchSymbols(name, limit, filePath);
		if (local.length > 0) return local;
		return this.matchSymbols(name, limit, null);
	}

	private matchSymbols(
		name: string,
		limit: number,
		filePath: string | null,
	): string[] {
		const parts = symbolKeyParts(name);
		return this.db
			.query<
				{ name: string },
				{
					$file: string | null;
					$full: string;
					$last: string;
					$owner: string;
					$limit: number;
				}
			>(matchSymbolsSql)
			.all({
				$file: filePath,
				$full: parts.key,
				$last: parts.lastSegment,
				$owner: parts.owner,
				$limit: limit,
			})
			.map((row) => row.name);
	}

	listImports(): Array<{
		fromPath: string;
		specifier: string;
		toPath: string | null;
	}> {
		return this.db
			.query<
				{ from_path: string; specifier: string; to_path: string | null },
				[]
			>(
				"SELECT from_path, specifier, to_path FROM imports ORDER BY from_path, specifier",
			)
			.all()
			.map((row) => ({
				fromPath: row.from_path,
				specifier: row.specifier,
				toPath: row.to_path,
			}));
	}

	importsFrom(path: string): CodeImport[] {
		return this.db
			.query<ImportRow, [string]>(
				`SELECT specifier, to_path, provenance FROM imports
				 WHERE from_path = ? ORDER BY specifier`,
			)
			.all(path)
			.map((row) => ({
				specifier: row.specifier,
				toPath: row.to_path,
				provenance: row.provenance,
			}));
	}

	private insertEntry(entry: FileIndexEntry): void {
		this.insertFile(entry.file);
		this.insertSymbols(entry.file.path, entry.symbols);
		this.insertImports(entry.file.path, entry.imports);
	}

	private insertFile(file: IndexedFile): void {
		this.db
			.query(
				"INSERT INTO files (path, lang, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
			)
			.run(file.path, file.lang, file.hash, file.mtime, file.size);
	}

	private insertSymbols(filePath: string, symbols: CodeSymbol[]): void {
		const statement = this.db.query(
			"INSERT INTO symbols (file_path, name, kind, line) VALUES (?, ?, ?, ?)",
		);
		for (const symbol of symbols) {
			statement.run(
				filePath,
				canonicalSymbolName(symbol.name),
				symbol.kind,
				symbol.line,
			);
		}
	}

	private insertImports(fromPath: string, imports: CodeImport[]): void {
		const statement = this.db.query(
			"INSERT INTO imports (from_path, to_path, specifier, provenance) VALUES (?, ?, ?, ?)",
		);
		for (const entry of imports) {
			statement.run(fromPath, entry.toPath, entry.specifier, entry.provenance);
		}
	}

	private deleteFileRows(path: string): void {
		this.db.query("DELETE FROM symbols WHERE file_path = ?").run(path);
		this.db.query("DELETE FROM imports WHERE from_path = ?").run(path);
		this.db.query("DELETE FROM files WHERE path = ?").run(path);
	}
}
