import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { CodeRepository } from "@/storage/code-repository";
import { openCodeDb } from "@/storage/connection";
import { migrateCode } from "@/storage/migrations";
import { CodeIndexer } from "./code-indexer";

interface OpenIndex {
	database: Database;
	repository: CodeRepository;
}

// MCP sessions reconcile the code index lazily: the first query that touches
// code.db pays for the catch-up of edits made while the server was down.
export class LazyCodeIndex {
	private open: OpenIndex | null = null;

	constructor(private readonly repoRoot: string) {}

	async repository(): Promise<CodeRepository> {
		this.open ??= await this.reconcile();
		return this.open.repository;
	}

	dispose(): void {
		this.open?.database.close();
		this.open = null;
	}

	private async reconcile(): Promise<OpenIndex> {
		const database = openCodeDb(join(this.repoRoot, ".cortex"));
		migrateCode(database);
		const repository = new CodeRepository(database);
		const indexer = await CodeIndexer.create(this.repoRoot, repository);
		await indexer.run();
		return { database, repository };
	}
}
