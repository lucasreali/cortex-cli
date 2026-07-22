import { join } from "node:path";
import { type OpenCodeRepository, openCodeRepository } from "@/storage/code-db";
import type { CodeRepository } from "@/storage/code-repository";
import { CodeIndexer } from "./code-indexer";

export interface CodeIndex {
	repository(): Promise<CodeRepository>;
	dispose(): void;
}

// MCP sessions reconcile the code index lazily: the first query that touches
// code.db pays for the catch-up of edits made while the server was down.
export class LazyCodeIndex implements CodeIndex {
	private open: OpenCodeRepository | null = null;

	constructor(private readonly repoRoot: string) {}

	async repository(): Promise<CodeRepository> {
		this.open ??= await this.reconcile();
		return this.open.repository;
	}

	dispose(): void {
		this.open?.database.close();
		this.open = null;
	}

	private async reconcile(): Promise<OpenCodeRepository> {
		const open = openCodeRepository(join(this.repoRoot, ".cortex"));
		const indexer = await CodeIndexer.create(this.repoRoot, open.repository);
		await indexer.run();
		return open;
	}
}
