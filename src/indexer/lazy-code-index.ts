import { join } from "node:path";
import { type OpenCodeRepository, openCodeRepository } from "@/storage/code-db";
import type { CodeRepository } from "@/storage/code-repository";
import { CodeIndexer } from "./code-indexer";

export interface CodeIndex {
	repository(): Promise<CodeRepository>;
	dispose(): void;
}

export class LazyCodeIndex implements CodeIndex {
	private opening: Promise<OpenCodeRepository> | null = null;

	constructor(private readonly repoRoot: string) {}

	// Concurrent callers share the reconcile in flight: caching the promise
	// rather than its result keeps a session from opening a second connection
	// to code.db while the first one is still catching up. A failed reconcile
	// is not cached, so the next call retries it.
	async repository(): Promise<CodeRepository> {
		this.opening ??= this.reconcile().catch((error) => {
			this.opening = null;
			throw error;
		});
		const open = await this.opening;
		return open.repository;
	}

	dispose(): void {
		const pending = this.opening;
		this.opening = null;
		void pending?.then(
			(open) => open.database.close(),
			() => undefined,
		);
	}

	private async reconcile(): Promise<OpenCodeRepository> {
		const open = openCodeRepository(join(this.repoRoot, ".cortex"));
		const indexer = await CodeIndexer.create(this.repoRoot, open.repository);
		await indexer.run();
		return open;
	}
}
