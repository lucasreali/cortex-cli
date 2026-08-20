import { join } from "node:path";
import type { CodeImport, FileIndexEntry, IndexedFile } from "@/domain";
import type { CodeRepository } from "@/storage/code-repository";
import { errorMessage } from "@/support/errors";
import { sha256Hex } from "@/support/hash";
import { EXTRACTION_VERSION } from "./extraction-version";
import { ensureGrammar } from "./grammar";
import { ImportResolver } from "./import-resolver";
import {
	listSources,
	type SkippedSource,
	type SourceFile,
	type SourceListing,
} from "./source-walker";
import type { ExtractedSource } from "./tsx-extractor";
import { TsxExtractor } from "./tsx-extractor";

export interface IndexReport {
	mode: "full" | "incremental";
	indexed: number;
	unchanged: number;
	removed: number;
	skipped: SkippedSource[];
}

export interface IndexOptions {
	force?: boolean;
}

export interface IndexDrift {
	added: number;
	changed: number;
	removed: number;
}

interface IndexPass {
	resolver: ImportResolver;
	report: IndexReport;
}

const NOTHING_EXTRACTED: ExtractedSource = { symbols: [], imports: [] };

const NUL_BYTE = "\u0000";

const BINARY_REASON = "binary content, not source text";

// doctor reports drift from computeDrift while index acts on reconcileSource;
// they have to agree on what "stale" means or doctor calls a stale index clean.
function isUnchanged(previous: IndexedFile, source: SourceFile): boolean {
	return previous.size === source.size && previous.mtime === source.mtime;
}

function skippedPaths(listing: SourceListing): Set<string> {
	return new Set(listing.skipped.map((entry) => entry.path));
}

function parsableSources(listing: SourceListing): SourceFile[] {
	const skipped = skippedPaths(listing);
	return listing.files.filter((source) => !skipped.has(source.path));
}

export function computeDrift(
	listing: SourceListing,
	indexed: IndexedFile[],
): IndexDrift {
	const skipped = skippedPaths(listing);
	const known = new Map(indexed.map((file) => [file.path, file]));
	const drift: IndexDrift = { added: 0, changed: 0, removed: 0 };
	for (const source of listing.files) {
		const previous = known.get(source.path);
		known.delete(source.path);
		if (skipped.has(source.path)) continue;
		if (!previous) {
			drift.added++;
			continue;
		}
		if (!isUnchanged(previous, source)) drift.changed++;
	}
	for (const path of skipped) known.delete(path);
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
		const listing = listSources(this.repoRoot);
		const resolver = await ImportResolver.create(
			this.repoRoot,
			listing.files.map((source) => source.path),
		);
		if (options.force || this.needsFullIndex()) {
			return this.fullIndex(listing, resolver);
		}
		return this.incrementalIndex(listing, resolver);
	}

	private needsFullIndex(): boolean {
		if (this.repository.listFiles().length === 0) return true;
		return this.repository.extractionVersion() !== EXTRACTION_VERSION;
	}

	private async fullIndex(
		listing: SourceListing,
		resolver: ImportResolver,
	): Promise<IndexReport> {
		const pass = startPass("full", listing, resolver);
		const entries: FileIndexEntry[] = [];
		for (const source of parsableSources(listing)) {
			const entry = await this.toEntry(source, pass);
			if (entry) entries.push(entry);
		}
		this.repository.wipeAndRebuild(entries);
		this.repository.stampExtractionVersion(EXTRACTION_VERSION);
		pass.report.indexed = entries.length;
		return pass.report;
	}

	private async incrementalIndex(
		listing: SourceListing,
		resolver: ImportResolver,
	): Promise<IndexReport> {
		const pass = startPass("incremental", listing, resolver);
		const known = new Map(
			this.repository.listFiles().map((file) => [file.path, file]),
		);
		for (const path of skippedPaths(listing)) known.delete(path);
		for (const source of parsableSources(listing)) {
			await this.reconcileSource(source, known, pass);
		}
		for (const path of known.keys()) {
			this.repository.removeFile(path);
			pass.report.removed++;
		}
		return pass.report;
	}

	private async reconcileSource(
		source: SourceFile,
		known: Map<string, IndexedFile>,
		pass: IndexPass,
	): Promise<void> {
		const previous = known.get(source.path);
		known.delete(source.path);
		if (previous && isUnchanged(previous, source)) {
			pass.report.unchanged++;
			return;
		}
		await this.reindexChanged(source, previous, pass);
	}

	private async reindexChanged(
		source: SourceFile,
		previous: IndexedFile | undefined,
		pass: IndexPass,
	): Promise<void> {
		const content = await this.readSource(source, pass.report);
		if (content === null) return;
		const hash = sha256Hex(content);
		if (previous?.hash === hash) {
			this.repository.touchFile({ ...source, hash });
			pass.report.unchanged++;
			return;
		}
		this.repository.upsertFile(this.toEntryOf(source, hash, content, pass));
		pass.report.indexed++;
	}

	private async toEntry(
		source: SourceFile,
		pass: IndexPass,
	): Promise<FileIndexEntry | null> {
		const content = await this.readSource(source, pass.report);
		if (content === null) return null;
		return this.toEntryOf(source, sha256Hex(content), content, pass);
	}

	// A file that vanished between the listing and the read is the ordinary race
	// against a checkout or an editor save, and an unreadable one is still just
	// one file: either way the pass keeps its remaining files.
	private async readSource(
		source: SourceFile,
		report: IndexReport,
	): Promise<string | null> {
		try {
			return await Bun.file(join(this.repoRoot, source.path)).text();
		} catch (error) {
			report.skipped.push({ path: source.path, reason: errorMessage(error) });
			return null;
		}
	}

	private toEntryOf(
		source: SourceFile,
		hash: string,
		content: string,
		pass: IndexPass,
	): FileIndexEntry {
		const extracted = this.extractionOf(source, content, pass.report);
		return {
			file: { ...source, hash },
			symbols: extracted.symbols,
			imports: extracted.imports.map((specifier) =>
				this.toImport(source.path, specifier, pass.resolver),
			),
		};
	}

	// A blob that happens to carry a source extension parses for a second and
	// yields nothing; the row is still worth keeping so the file stops looking
	// like drift on every later pass.
	private extractionOf(
		source: SourceFile,
		content: string,
		report: IndexReport,
	): ExtractedSource {
		if (!content.includes(NUL_BYTE)) return this.extractor.extract(content);
		report.skipped.push({ path: source.path, reason: BINARY_REASON });
		return NOTHING_EXTRACTED;
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

function startPass(
	mode: IndexReport["mode"],
	listing: SourceListing,
	resolver: ImportResolver,
): IndexPass {
	return {
		resolver,
		report: {
			mode,
			indexed: 0,
			unchanged: 0,
			removed: 0,
			skipped: [...listing.skipped],
		},
	};
}
