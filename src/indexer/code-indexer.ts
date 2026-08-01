import { join } from "node:path";
import type { CodeImport, FileIndexEntry, IndexedFile } from "@/domain";
import type { CodeRepository } from "@/storage/code-repository";
import { sha256Hex } from "@/support/hash";
import { EXTRACTION_VERSION } from "./extraction-version";
import { ensureGrammar } from "./grammar";
import { ImportResolver } from "./import-resolver";
import { listSourceFiles, type SourceFile } from "./source-walker";
import { TsxExtractor } from "./tsx-extractor";

export interface IndexReport {
	mode: "full" | "incremental";
	indexed: number;
	unchanged: number;
	removed: number;
}

export interface IndexOptions {
	force?: boolean;
}

export interface IndexDrift {
	added: number;
	changed: number;
	removed: number;
}

// doctor reports drift from computeDrift while index acts on reconcileSource;
// they have to agree on what "stale" means or doctor calls a stale index clean.
function isUnchanged(previous: IndexedFile, source: SourceFile): boolean {
	return previous.size === source.size && previous.mtime === source.mtime;
}

export function computeDrift(
	sources: SourceFile[],
	indexed: IndexedFile[],
): IndexDrift {
	const known = new Map(indexed.map((file) => [file.path, file]));
	const drift: IndexDrift = { added: 0, changed: 0, removed: 0 };
	for (const source of sources) {
		const previous = known.get(source.path);
		known.delete(source.path);
		if (!previous) drift.added++;
		else if (!isUnchanged(previous, source)) drift.changed++;
	}
	drift.removed = known.size;
	return drift;
}

export class CodeIndexer {
	static async create(
		repoRoot: string,
		repository: CodeRepository,
	): Promise<CodeIndexer> {
		const extractor = await TsxExtractor.create(await ensureGrammar());
		return new CodeIndexer(repoRoot, repository, extractor);
	}

	private constructor(
		private readonly repoRoot: string,
		private readonly repository: CodeRepository,
		private readonly extractor: TsxExtractor,
	) {}

	async run(options: IndexOptions = {}): Promise<IndexReport> {
		const sources = listSourceFiles(this.repoRoot);
		const resolver = await ImportResolver.create(
			this.repoRoot,
			sources.map((source) => source.path),
		);
		if (options.force || this.needsFullIndex()) {
			return this.fullIndex(sources, resolver);
		}
		return this.incrementalIndex(sources, resolver);
	}

	private needsFullIndex(): boolean {
		if (this.repository.listFiles().length === 0) return true;
		return this.repository.extractionVersion() !== EXTRACTION_VERSION;
	}

	private async fullIndex(
		sources: SourceFile[],
		resolver: ImportResolver,
	): Promise<IndexReport> {
		const entries: FileIndexEntry[] = [];
		for (const source of sources) {
			entries.push(await this.toEntry(source, resolver));
		}
		this.repository.wipeAndRebuild(entries);
		this.repository.stampExtractionVersion(EXTRACTION_VERSION);
		return { mode: "full", indexed: entries.length, unchanged: 0, removed: 0 };
	}

	private async incrementalIndex(
		sources: SourceFile[],
		resolver: ImportResolver,
	): Promise<IndexReport> {
		const known = new Map(
			this.repository.listFiles().map((file) => [file.path, file]),
		);
		const report: IndexReport = {
			mode: "incremental",
			indexed: 0,
			unchanged: 0,
			removed: 0,
		};
		for (const source of sources) {
			await this.reconcileSource(source, known, resolver, report);
		}
		for (const path of known.keys()) {
			this.repository.removeFile(path);
			report.removed++;
		}
		return report;
	}

	private async reconcileSource(
		source: SourceFile,
		known: Map<string, IndexedFile>,
		resolver: ImportResolver,
		report: IndexReport,
	): Promise<void> {
		const previous = known.get(source.path);
		known.delete(source.path);
		if (previous && isUnchanged(previous, source)) {
			report.unchanged++;
			return;
		}
		await this.reindexChanged(source, previous, resolver, report);
	}

	private async reindexChanged(
		source: SourceFile,
		previous: IndexedFile | undefined,
		resolver: ImportResolver,
		report: IndexReport,
	): Promise<void> {
		const content = await Bun.file(join(this.repoRoot, source.path)).text();
		const hash = sha256Hex(content);
		if (previous?.hash === hash) {
			this.repository.touchFile({ ...source, hash });
			report.unchanged++;
			return;
		}
		this.repository.upsertFile(this.toEntryOf(source, hash, content, resolver));
		report.indexed++;
	}

	private async toEntry(
		source: SourceFile,
		resolver: ImportResolver,
	): Promise<FileIndexEntry> {
		const content = await Bun.file(join(this.repoRoot, source.path)).text();
		return this.toEntryOf(source, sha256Hex(content), content, resolver);
	}

	private toEntryOf(
		source: SourceFile,
		hash: string,
		content: string,
		resolver: ImportResolver,
	): FileIndexEntry {
		const extracted = this.extractor.extract(content);
		return {
			file: { ...source, hash },
			symbols: extracted.symbols,
			imports: extracted.imports.map((specifier) =>
				this.toImport(source.path, specifier, resolver),
			),
		};
	}

	private toImport(
		fromPath: string,
		specifier: string,
		resolver: ImportResolver,
	): CodeImport {
		const resolved = resolver.resolve(fromPath, specifier);
		return {
			specifier,
			toPath: resolved.toPath,
			provenance: resolved.provenance,
		};
	}
}
