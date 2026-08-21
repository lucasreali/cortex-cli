import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { exportDecisionsIfNeeded } from "@/decisions/bootstrap";
import { type DecisionSync, openDecisionSync } from "@/decisions/decision-sync";
import type { ReconcileReport } from "@/decisions/reconcile";
import {
	createProvider,
	embeddingsDisabled,
} from "@/embedding/create-provider";
import { GEMMA_MODEL } from "@/embedding/model";
import type { EmbeddingProvider } from "@/embedding/provider";
import { EmbedQueue } from "@/embedding/queue";
import { SemanticSearch } from "@/embedding/semantic-search";
import { getCanonicalProjectId, getHead, getRepoRoot } from "@/git";
import { type CodeIndex, LazyCodeIndex } from "@/indexer/lazy-code-index";
import { QueryLog } from "@/querylog/query-log";
import { QueryRecorder } from "@/querylog/recorder";
import { QueryLogSettings } from "@/querylog/settings";
import { readConfig, writeConfig } from "@/storage/config";
import { openDecisionsDb } from "@/storage/connection";
import { EdgeRepository } from "@/storage/edge-repository";
import { EmbeddingRepository } from "@/storage/embedding-repository";
import { migrate, SCHEMA_VERSION } from "@/storage/migrations";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";
import { ProjectRoot } from "@/storage/project-root";
import { SearchRepository } from "@/storage/search-repository";
import { SessionIdentity } from "@/support/session-identity";
import { UsefulnessEventLog } from "@/usefulness/event-log";
import { UsefulnessRecorder } from "@/usefulness/recorder";

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
	decisions: DecisionSync;
	usefulness: UsefulnessRecorder;
	queries: QueryRecorder;
	ensureSession(): string;
	saveContext(): SaveContext;
	dispose(): void;
}

export interface RuntimeOptions {
	sharedEmbedding?: boolean;
	busyTimeoutMs?: number;
}

export async function buildRuntime(cwd: string): Promise<CortexRuntime> {
	return buildRuntimeAt(getRepoRoot(cwd) ?? resolve(cwd));
}

// The connection is closed by hand on every failure path: a store that throws
// on migrate or on any later step would otherwise leak its handle, and a
// server that retries a corrupt project climbs to its fd limit one call at a
// time.
export async function buildRuntimeAt(
	repoRoot: string,
	options: RuntimeOptions = {},
): Promise<CortexRuntime> {
	const project = ProjectRoot.at(repoRoot);
	const cortexDir = project.cortexDir;
	mkdirSync(cortexDir, { recursive: true });
	const db = openDecisionsDb(cortexDir, {
		busyTimeoutMs: options.busyTimeoutMs,
	});
	try {
		return await assembleRuntime(repoRoot, project, db, options);
	} catch (error) {
		db.close();
		throw error;
	}
}

async function assembleRuntime(
	repoRoot: string,
	project: ProjectRoot,
	db: Database,
	options: RuntimeOptions,
): Promise<CortexRuntime> {
	const cortexDir = project.cortexDir;
	exportDecisionsIfNeeded(cortexDir, db, migrate(db));

	const nodes = new NodeRepository(db);
	const edges = new EdgeRepository(db);
	const fts = new SearchRepository(db);
	const embeddings = new EmbeddingRepository(db);
	// The config is the single source of truth for the embedding space: the
	// provider is built from the pinned model_id, and an unknown id fails the
	// startup loudly instead of drifting silently. Mixing vectors from
	// different models in one store would corrupt every similarity score.
	const config = await readConfig(cortexDir);
	// migrate() just brought the store to SCHEMA_VERSION, so a lower number in
	// the config is a stale label, not a finding. Only ever raised: an older
	// binary opening a newer store must leave doctor's warning standing.
	if (config && config.schema_version < SCHEMA_VERSION) {
		await writeConfig(cortexDir, {
			...config,
			schema_version: SCHEMA_VERSION,
		});
	}
	const codeIndex = new LazyCodeIndex(repoRoot);
	const projectCanonicalId = getCanonicalProjectId(repoRoot) ?? repoRoot;
	// Everything that can throw runs before the provider exists, so the only
	// resource a failed build has to release is the connection its caller
	// closes — a worker subprocess spawned here would outlive the throw.
	const projectNodeId = nodes.ensureProject(projectCanonicalId);
	// Minted here, inserted only when a write path needs the row: the local
	// usefulness log keys its events by this id from the first read, and a
	// read-only tool must not leave a session node behind to be recorded. It is
	// an identity rather than a string because this runtime may be cached by a
	// server that outlives the conversation that opened it.
	const session = new SessionIdentity();
	const pinnedModelId = config?.model_id ?? GEMMA_MODEL.modelId;
	const provider = embeddingsDisabled()
		? null
		: createProvider(pinnedModelId, {
				shared: options.sharedEmbedding === true,
			});
	const usefulnessLog = new UsefulnessEventLog(project.usefulnessLogPath);
	const semanticSearch = new SemanticSearch({
		nodes,
		embeddings,
		fts,
		provider,
		usefulness: usefulnessLog,
	});
	const queue = provider
		? new EmbedQueue({
				nodes,
				embeddings,
				provider,
				onEmbedded: () => semanticSearch.invalidate(),
			})
		: null;
	// Reconciling deliberately does not enqueue: pulling a branch must not make
	// `cortex log` load the model, and a CLI process disposes the moment the
	// command ends, which would drop the embedding anyway. Imported decisions
	// answer through FTS until `cortex embed --missing` runs, which doctor
	// reports and which costs about 0.02 recall@5 in the meantime.
	const decisions = openDecisionSync({
		cortexDir,
		db,
		onReconciled: (report) => {
			if (touched(report)) semanticSearch.invalidate();
		},
	});
	// One session node per identity, not per runtime: a server that has rolled
	// into a new conversation must not hang this one's GENERATED_IN off the
	// node the previous conversation created.
	let sessionNode: { of: string; id: string } | null = null;
	const ensureSession = (): string => {
		const current = session.current();
		if (sessionNode?.of !== current) {
			sessionNode = {
				of: current,
				id: nodes.createSession(projectNodeId, current),
			};
		}
		return sessionNode.id;
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
		decisions,
		usefulness: new UsefulnessRecorder(usefulnessLog, session),
		queries: new QueryRecorder(
			new QueryLog(QueryLogSettings.from(cortexDir)),
			session,
		),
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

// Only a change in what this branch carries can invalidate the vector cache:
// a reconcile that found nothing leaves every cached vector answering for the
// same decision it did before.
function touched(report: ReconcileReport): boolean {
	return (
		report.imported.length + report.absent.length + report.restored.length > 0
	);
}
