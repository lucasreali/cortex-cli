import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createProvider } from "@/embedding/create-provider";
import { GEMMA_MODEL } from "@/embedding/model";
import type { EmbeddingProvider } from "@/embedding/provider";
import { EmbedQueue } from "@/embedding/queue";
import { SemanticSearch } from "@/embedding/semantic-search";
import { getCanonicalProjectId, getHead, getRepoRoot } from "@/git";
import { type CodeIndex, LazyCodeIndex } from "@/indexer/lazy-code-index";
import { readConfig } from "@/storage/config";
import { openDecisionsDb } from "@/storage/connection";
import { EdgeRepository } from "@/storage/edge-repository";
import { EmbeddingRepository } from "@/storage/embedding-repository";
import { migrate } from "@/storage/migrations";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";
import { SearchRepository } from "@/storage/search-repository";

export interface CortexRuntime {
	repoRoot: string;
	cortexDir: string;
	projectNodeId: string;
	projectCanonicalId: string;
	pinnedModelId: string;
	nodes: NodeRepository;
	edges: EdgeRepository;
	fts: SearchRepository;
	embeddings: EmbeddingRepository;
	provider: EmbeddingProvider | null;
	queue: EmbedQueue | null;
	semanticSearch: SemanticSearch;
	codeIndex: CodeIndex;
	ensureSession(): string;
	saveContext(): SaveContext;
	dispose(): void;
}

export interface RuntimeOptions {
	sharedEmbedding?: boolean;
}

export async function buildRuntime(cwd: string): Promise<CortexRuntime> {
	return buildRuntimeAt(getRepoRoot(cwd) ?? resolve(cwd));
}

export async function buildRuntimeAt(
	repoRoot: string,
	options: RuntimeOptions = {},
): Promise<CortexRuntime> {
	const cortexDir = join(repoRoot, ".cortex");
	mkdirSync(cortexDir, { recursive: true });
	const db = openDecisionsDb(cortexDir);
	migrate(db);

	const nodes = new NodeRepository(db);
	const edges = new EdgeRepository(db);
	const fts = new SearchRepository(db);
	const embeddings = new EmbeddingRepository(db);
	// The config is the single source of truth for the embedding space: the
	// provider is built from the pinned model_id, and an unknown id fails the
	// startup loudly instead of drifting silently. Mixing vectors from
	// different models in one store would corrupt every similarity score.
	const config = await readConfig(cortexDir);
	const pinnedModelId = config?.model_id ?? GEMMA_MODEL.modelId;
	const provider = embeddingsDisabled()
		? null
		: createProvider(pinnedModelId, {
				shared: options.sharedEmbedding === true,
			});
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
	const codeIndex = new LazyCodeIndex(repoRoot);
	const projectCanonicalId = getCanonicalProjectId(repoRoot) ?? repoRoot;
	const projectNodeId = nodes.ensureProject(projectCanonicalId);
	let sessionNodeId: string | null = null;
	const ensureSession = (): string => {
		sessionNodeId ??= nodes.createSession(projectNodeId);
		return sessionNodeId;
	};

	return {
		repoRoot,
		cortexDir,
		projectNodeId,
		projectCanonicalId,
		pinnedModelId,
		nodes,
		edges,
		fts,
		embeddings,
		provider,
		queue,
		semanticSearch,
		codeIndex,
		ensureSession,
		saveContext() {
			const head = getHead(repoRoot);
			return {
				projectId: projectNodeId,
				sessionId: ensureSession(),
				commitSha: head?.sha ?? null,
				commitDirty: head?.dirty ?? false,
			};
		},
		dispose() {
			provider?.dispose?.();
			codeIndex.dispose();
			db.close();
		},
	};
}

function embeddingsDisabled(): boolean {
	return process.env.CORTEX_DISABLE_EMBEDDINGS === "1";
}
