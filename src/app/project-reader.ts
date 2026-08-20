import type { Database } from "bun:sqlite";
import {
	SemanticSearch,
	type SemanticSearchResult,
} from "@/embedding/semantic-search";
import { openDecisionsDbReadOnly } from "@/storage/connection";
import { EmbeddingRepository } from "@/storage/embedding-repository";
import { SCHEMA_VERSION } from "@/storage/migrations";
import { NodeRepository } from "@/storage/node-repository";
import { ProjectRoot } from "@/storage/project-root";
import { SearchRepository } from "@/storage/search-repository";
import {
	type DecisionQuery,
	findDecisions,
	type SearchDependencies,
} from "./search-decisions";

const READ_BUSY_TIMEOUT_MS = 1000;

// What a foreign project may be asked for during a cross-project sweep: a
// query, and nothing else. The tools that fan out are annotated read-only, so
// opening a project the user did not name must not mkdir, migrate, export
// decision files into its working tree, reconcile or register it — and a store
// behind the current schema is reported as skipped rather than upgraded.
export class ProjectReader {
	private constructor(
		private readonly db: Database,
		private readonly store: SearchDependencies,
	) {}

	static open(root: string): ProjectReader {
		const db = openDecisionsDbReadOnly(ProjectRoot.at(root).cortexDir, {
			busyTimeoutMs: READ_BUSY_TIMEOUT_MS,
		});
		try {
			assertCurrentSchema(db);
			return new ProjectReader(db, readOnlyStore(db));
		} catch (error) {
			db.close();
			throw error;
		}
	}

	find(query: DecisionQuery): SemanticSearchResult[] {
		return findDecisions(this.store, query);
	}

	close(): void {
		this.db.close();
	}
}

function readOnlyStore(db: Database): SearchDependencies {
	const nodes = new NodeRepository(db);
	const fts = new SearchRepository(db);
	const embeddings = new EmbeddingRepository(db);
	return {
		nodes,
		fts,
		semanticSearch: new SemanticSearch({
			nodes,
			fts,
			embeddings,
			provider: null,
		}),
	};
}

function assertCurrentSchema(db: Database): void {
	const row = db
		.query<{ version: number | null }, []>(
			"SELECT MAX(id) AS version FROM _migrations",
		)
		.get();
	const version = row?.version ?? 0;
	if (version >= SCHEMA_VERSION) return;
	throw new Error(
		`store is at schema ${version}, this binary expects ${SCHEMA_VERSION}; ` +
			"run any cortex command in that project to migrate it",
	);
}
