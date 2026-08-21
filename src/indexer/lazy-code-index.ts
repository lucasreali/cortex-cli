import { type OpenCodeRepository, openCodeRepository } from "@/storage/code-db";
import type { CodeRepository } from "@/storage/code-repository";
import { ProjectRoot } from "@/storage/project-root";
import { CodeIndexer } from "./code-indexer";

export interface CodeIndex {
	repository(): Promise<CodeRepository>;
	dispose(): void;
}

// A reconcile is a snapshot, and an MCP server outlives many of them: a session
// writes a function, then anchors a decision to it, and a snapshot taken at
// startup calls that anchor wrong. There is still no file watcher, so a later
// request re-checks instead. The window is what keeps a burst of tool calls from
// walking the tree once each; an unchanged pass is a directory walk and a stat
// per file, not a parse.
export const RECHECK_AFTER_MS = 5000;

interface OpenIndex {
	open: OpenCodeRepository;
	indexer: CodeIndexer;
}

export class LazyCodeIndex implements CodeIndex {
	private index: Promise<OpenIndex> | null = null;
	private freshUntil = 0;

	constructor(
		private readonly repoRoot: string,
		private readonly now: () => number = Date.now,
	) {}

	async repository(): Promise<CodeRepository> {
		const { open } = await this.reconciled();
		return open.repository;
	}

	dispose(): void {
		const pending = this.index;
		this.index = null;
		this.freshUntil = 0;
		void pending?.then(
			({ open }) => open.database.close(),
			() => undefined,
		);
	}

	// Concurrent callers share the pass in flight: caching the promise rather
	// than its result keeps a session from opening a second connection to
	// code.db while the first one is still catching up. A pass in flight is
	// fresh by definition, which is what the infinite window encodes. A failed
	// pass is not cached, so the next call retries it — and only the pass that
	// failed may clear the field, or a dispose racing it would drop a live one.
	private reconciled(): Promise<OpenIndex> {
		if (this.index && this.now() < this.freshUntil) return this.index;
		const established = this.index;
		this.freshUntil = Number.POSITIVE_INFINITY;
		const started: Promise<OpenIndex> = this.pass(established).then(
			(index) => {
				if (this.index === started)
					this.freshUntil = this.now() + RECHECK_AFTER_MS;
				return index;
			},
			(error) => {
				if (this.index === started) this.dropIndex();
				throw error;
			},
		);
		this.index = started;
		return started;
	}

	private dropIndex(): void {
		this.index = null;
		this.freshUntil = 0;
	}

	// The connection is closed here rather than left to dispose(): a rejected
	// pass is not cached, so nothing holds the handle afterwards and every later
	// retry would leak another one. The indexer outlives the pass that built it
	// for the same reason a re-check is cheap — a second one would reload the
	// grammar and hold a second parser for the life of the process.
	private async pass(
		established: Promise<OpenIndex> | null,
	): Promise<OpenIndex> {
		const index = (await established) ?? (await this.openIndex());
		try {
			await index.indexer.run();
			return index;
		} catch (error) {
			index.open.database.close();
			throw error;
		}
	}

	private async openIndex(): Promise<OpenIndex> {
		const open = openCodeRepository(ProjectRoot.at(this.repoRoot).cortexDir);
		try {
			const indexer = await CodeIndexer.create(this.repoRoot, open.repository);
			return { open, indexer };
		} catch (error) {
			open.database.close();
			throw error;
		}
	}
}
