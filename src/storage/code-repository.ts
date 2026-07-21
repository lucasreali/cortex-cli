import type { Database } from "bun:sqlite";
import type {
	CodeImport,
	CodeSymbol,
	FileIndexEntry,
	ImportProvenance,
	IndexedFile,
} from "@/domain";

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
