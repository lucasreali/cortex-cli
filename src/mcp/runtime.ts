import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { GemmaProvider } from "@/embedding/gemma-provider";
import { EmbedQueue } from "@/embedding/queue";
import { SemanticSearch } from "@/embedding/semantic-search";
import { getCanonicalProjectId, getHead, getRepoRoot } from "@/git";
import { openDecisionsDb } from "@/storage/connection";
import { EdgeRepository } from "@/storage/edge-repository";
import { EmbeddingRepository } from "@/storage/embedding-repository";
import { migrate } from "@/storage/migrations";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";
import { SearchRepository } from "@/storage/search-repository";

export interface CortexRuntime {
	repoRoot: string;
	projectNodeId: string;
	nodes: NodeRepository;
	edges: EdgeRepository;
	fts: SearchRepository;
	embeddings: EmbeddingRepository;
	queue: EmbedQueue | null;
	semanticSearch: SemanticSearch;
	ensureSession(): string;
	saveContext(): SaveContext;
	dispose(): void;
}

export function buildRuntime(cwd: string): CortexRuntime {
	const repoRoot = getRepoRoot(cwd) ?? resolve(cwd);
	const cortexDir = join(repoRoot, ".cortex");
	mkdirSync(cortexDir, { recursive: true });
	const db = openDecisionsDb(cortexDir);
	migrate(db);

	const nodes = new NodeRepository(db);
	const edges = new EdgeRepository(db);
	const fts = new SearchRepository(db);
	const embeddings = new EmbeddingRepository(db);
	const provider = embeddingsDisabled() ? null : new GemmaProvider();
	const semanticSearch = new SemanticSearch({
		nodes,
		embeddings,
		fts,
		provider,
	});
	const queue = provider
		? new EmbedQueue({
				nodes,
				embeddings,
				provider,
				onEmbedded: () => semanticSearch.invalidate(),
			})
		: null;
	const projectNodeId = nodes.ensureProject(
		getCanonicalProjectId(repoRoot) ?? repoRoot,
	);
	let sessionNodeId: string | null = null;

	return {
		repoRoot,
		projectNodeId,
		nodes,
		edges,
		fts,
		embeddings,
		queue,
		semanticSearch,
		ensureSession() {
			sessionNodeId ??= nodes.createSession(projectNodeId);
			return sessionNodeId;
		},
		saveContext() {
			const head = getHead(repoRoot);
			return {
				projectId: projectNodeId,
				sessionId: this.ensureSession(),
				commitSha: head?.sha ?? null,
				commitDirty: head?.dirty ?? false,
			};
		},
		dispose() {
			provider?.dispose();
			db.close();
		},
	};
}

function embeddingsDisabled(): boolean {
	return process.env.CORTEX_DISABLE_EMBEDDINGS === "1";
}
