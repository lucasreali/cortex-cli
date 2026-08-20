import { resolve } from "node:path";
import { ProjectReader } from "@/app/project-reader";
import { buildRuntimeAt, type CortexRuntime } from "@/app/runtime";
import {
	embeddingsDisabled,
	embedSweepQuery,
	sweepModelId,
} from "@/app/sweep-query";
import { createProvider } from "@/embedding/create-provider";
import type { EmbeddingProvider } from "@/embedding/provider";
import type { QueryVector } from "@/embedding/semantic-search";
import { withTimeout } from "@/embedding/with-timeout";
import { findNearestCortexRoot } from "@/storage/locate-store";
import { registerProject } from "@/storage/project-registry";

type DefaultProject = { root: string } | { guidance: string };

export interface UnresolvedProject {
	ok: false;
	status: string;
	guidance: string;
}

// Each cached runtime holds an open decisions.db, a lazily opened code.db and
// an embedding provider, so an unbounded cache is an unbounded fd and memory
// footprint for a server that may live for days.
const MAX_CACHED_RUNTIMES = 8;
// bun:sqlite blocks the event loop while it waits, so the MCP server trades a
// long wait on a busy store for a fast error the agent can retry.
const MCP_BUSY_TIMEOUT_MS = 1000;
const SHUTDOWN_DRAIN_MS = 5000;

const SHUTTING_DOWN_GUIDANCE =
	"This Cortex server is shutting down and no longer serves queries. The " +
	"decisions themselves are safe in .cortex/decisions/; reconnect to the " +
	"server, or use the `cortex` CLI, to read them.";

export class RuntimeRegistry {
	private readonly runtimes = new LeasedRuntimes();
	private queryEmbedder: EmbeddingProvider | null = null;
	private closed = false;

	private constructor(private readonly defaultProject: DefaultProject) {}

	static fromCwd(cwd: string): RuntimeRegistry {
		const start = resolve(cwd);
		const root = findNearestCortexRoot(start);
		return new RuntimeRegistry(
			root ? { root } : { guidance: noDefaultGuidance(start) },
		);
	}

	get hasDefaultProject(): boolean {
		return "root" in this.defaultProject;
	}

	get defaultRoot(): string | null {
		return "root" in this.defaultProject ? this.defaultProject.root : null;
	}

	// A foreign project is read through a connection that outlives neither the
	// query nor this call: the fan-out must not migrate it, must not reconcile
	// it and must not pin it in a cache the user never asked to fill.
	openReader(root: string): ProjectReader {
		return ProjectReader.open(root);
	}

	// One embedding serves the whole sweep, on a provider that outlives it:
	// spawning and killing a worker per sweep would reload the model each time.
	async embedSweepQuery(intent: string): Promise<QueryVector | null> {
		const provider = await this.sharedQueryEmbedder();
		if (!provider) return null;
		return embedSweepQuery(provider, intent);
	}

	// The lease is what makes eviction safe: a runtime in use by an in-flight
	// tool call is never the one the cache closes to make room.
	async withRuntime<T>(
		projectPath: string | undefined,
		use: (runtime: CortexRuntime) => Promise<T>,
	): Promise<{ ok: true; value: T } | UnresolvedProject> {
		const root = this.rootFor(projectPath);
		if (typeof root !== "string") return root;
		const runtime = await this.acquire(root);
		try {
			return { ok: true, value: await use(runtime) };
		} finally {
			this.runtimes.release(root);
		}
	}

	// save_decision returns before its embedding finishes, so a runtime is only
	// torn down once its queue drains — otherwise a shutdown right after a save
	// silently drops the vector and leaves the decision FTS-only. The drain is
	// bounded and runs across projects at once: a supervisor that SIGKILLs at
	// 10 s would otherwise defeat the very drain this code exists to guarantee.
	async dispose(): Promise<void> {
		this.closed = true;
		this.queryEmbedder?.dispose?.();
		this.queryEmbedder = null;
		await this.runtimes.disposeAll(SHUTDOWN_DRAIN_MS);
	}

	private rootFor(projectPath: string | undefined): string | UnresolvedProject {
		if (this.closed) {
			return {
				ok: false,
				status: "shutting_down",
				guidance: SHUTTING_DOWN_GUIDANCE,
			};
		}
		// Caching by input path would pin its first resolution for the server's
		// whole lifetime, missing a project that gains its own .cortex/ later.
		if (projectPath) {
			return (
				findNearestCortexRoot(projectPath) ??
				notInitialized(notInitializedGuidance(projectPath))
			);
		}
		if ("guidance" in this.defaultProject) {
			return notInitialized(this.defaultProject.guidance);
		}
		return this.defaultProject.root;
	}

	private async sharedQueryEmbedder(): Promise<EmbeddingProvider | null> {
		if (this.closed || embeddingsDisabled()) return null;
		try {
			this.queryEmbedder ??= createProvider(
				await sweepModelId(this.defaultRoot),
				{ shared: true },
			);
		} catch {
			return null;
		}
		return this.queryEmbedder;
	}

	private acquire(root: string): Promise<CortexRuntime> {
		const leased = this.runtimes.lease(root);
		if (leased) return leased;
		// MCP sessions are long-lived and often concurrent, so they share the
		// embedding worker through the user-wide daemon instead of each
		// loading its own copy of the model.
		//
		// The decision files are reconciled once, when the session first
		// touches this project: a checkout later in the session is picked up by
		// the next `cortex` command, not here.
		const opening = buildRuntimeAt(root, {
			sharedEmbedding: true,
			busyTimeoutMs: MCP_BUSY_TIMEOUT_MS,
		}).then((runtime) => {
			runtime.decisions.ensure();
			registerProject(root, runtime.projectCanonicalId);
			return runtime;
		});
		return this.runtimes.admit(root, opening, MAX_CACHED_RUNTIMES);
	}
}

interface CachedRuntime {
	opening: Promise<CortexRuntime>;
	leases: number;
	usedAt: number;
}

// An LRU keyed by root, where "least recently used" only ever considers
// entries no handler is holding.
class LeasedRuntimes {
	private readonly entries = new Map<string, CachedRuntime>();
	private clock = 0;

	lease(root: string): Promise<CortexRuntime> | null {
		const entry = this.entries.get(root);
		if (!entry) return null;
		entry.leases += 1;
		entry.usedAt = this.tick();
		return entry.opening;
	}

	admit(
		root: string,
		opening: Promise<CortexRuntime>,
		capacity: number,
	): Promise<CortexRuntime> {
		this.entries.set(root, { opening, leases: 1, usedAt: this.tick() });
		opening.catch(() => this.entries.delete(root));
		void this.evictDownTo(capacity);
		return opening;
	}

	release(root: string): void {
		const entry = this.entries.get(root);
		if (entry) entry.leases -= 1;
	}

	async disposeAll(drainMs: number): Promise<void> {
		const pending = [...this.entries.values()];
		this.entries.clear();
		await Promise.all(pending.map((entry) => drainAndDispose(entry, drainMs)));
	}

	private async evictDownTo(capacity: number): Promise<void> {
		while (this.entries.size > capacity) {
			const victim = this.leastRecentlyIdle();
			if (!victim) return;
			this.entries.delete(victim[0]);
			await drainAndDispose(victim[1], SHUTDOWN_DRAIN_MS);
		}
	}

	private leastRecentlyIdle(): [string, CachedRuntime] | null {
		const idle = [...this.entries.entries()].filter(
			([, entry]) => entry.leases <= 0,
		);
		return idle.sort((a, b) => a[1].usedAt - b[1].usedAt)[0] ?? null;
	}

	private tick(): number {
		this.clock += 1;
		return this.clock;
	}
}

async function drainAndDispose(
	entry: CachedRuntime,
	drainMs: number,
): Promise<void> {
	const runtime = await bounded(entry.opening, drainMs);
	if (!runtime) return;
	await bounded(runtime.queue?.onIdle(), drainMs);
	runtime.dispose();
}

// Every await on the shutdown path is bounded: a store still opening on a dead
// mount, or a worker that will never answer, must not outlast the supervisor's
// patience and turn a drain into a SIGKILL.
function bounded<T>(
	work: Promise<T> | undefined,
	timeoutMs: number,
): Promise<T | null> {
	if (!work) return Promise.resolve(null);
	return withTimeout(work, timeoutMs).catch(() => null);
}

function notInitialized(guidance: string): UnresolvedProject {
	return { ok: false, status: "not_initialized", guidance };
}

function noDefaultGuidance(searchedFrom: string): string {
	return (
		"This Cortex server started outside any initialized project (no " +
		".cortex/decisions.db or .cortex/decisions/ found walking up from " +
		`${searchedFrom}), so there ` +
		"is no default project to fall back to. Pass the target project's " +
		"absolute path as projectPath — any directory inside it works. For a " +
		"project without a store, the user can run `cortex init` there to " +
		"enable it."
	);
}

function notInitializedGuidance(projectPath: string): string {
	return (
		`The project at ${projectPath} has no Cortex store (no ` +
		".cortex/decisions.db or .cortex/decisions/ found walking up from " +
		"it), so no decisions are " +
		"recorded there — a normal state, not a failure. Skip Cortex for that " +
		"project unless the user runs `cortex init` there; other initialized " +
		"projects can still be queried by passing their projectPath."
	);
}
