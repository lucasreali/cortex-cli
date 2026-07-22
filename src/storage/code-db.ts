import type { Database } from "bun:sqlite";
import { CodeRepository } from "./code-repository";
import { openCodeDb } from "./connection";
import { migrateCode } from "./migrations";

export interface OpenCodeRepository {
	database: Database;
	repository: CodeRepository;
}

export function openCodeRepository(cortexDir: string): OpenCodeRepository {
	const database = openCodeDb(cortexDir);
	migrateCode(database);
	return { database, repository: new CodeRepository(database) };
}
