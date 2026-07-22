import type { Database } from "bun:sqlite";
import type {
	CodeImport,
	CodeSymbol,
	FileIndexEntry,
	ImportProvenance,
	IndexedFile,
} from "@/domain";
import transitiveImportersSql from "./queries/transitive-importers.sql" with {
	type: "text",
};

export interface TransitiveImporter {
	path: string;
	depth: number;
	provenance: ImportProvenance;
}

export interface SymbolLocation {
	filePath: string;
	kind: string;
	line: number;
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

	hasSymbol(filePath: string, name: string): boolean {
		return (
			this.db
				.query("SELECT 1 FROM symbols WHERE file_path = ? AND name = ?")
				.get(filePath, name) !== null
		);
	}

	findSymbol(name: string): SymbolLocation[] {
		return this.db
			.query<{ file_path: string; kind: string; line: number }, [string]>(
				"SELECT file_path, kind, line FROM symbols WHERE name = ? ORDER BY file_path, line",
			)
			.all(name)
			.map((row) => ({
				filePath: row.file_path,
				kind: row.kind,
				line: row.line,
			}));
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
		const lastSegment = name.split(".").at(-1) ?? name;
		const owner = name.includes(".")
			? name.slice(0, name.lastIndexOf("."))
			: "";
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
			>(
				`SELECT DISTINCT name FROM symbols
				 WHERE ($file IS NULL OR file_path = $file)
				   AND (name LIKE '%' || $full || '%'
				     OR name LIKE '%' || $last || '%'
				     OR ($owner != '' AND name LIKE $owner || '.%'))
				 ORDER BY name LIMIT $limit`,
			)
			.all({
				$file: filePath,
				$full: name,
				$last: lastSegment,
				$owner: owner,
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
			statement.run(filePath, symbol.name, symbol.kind, symbol.line);
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
