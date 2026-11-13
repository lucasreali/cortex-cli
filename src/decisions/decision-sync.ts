import type { Database } from "bun:sqlite";
import type { CreateDecisionInput } from "@/domain";
import { DecisionSyncRepository } from "@/storage/decision-sync-repository";
import type { SaveContext } from "@/storage/node-repository";
import { DecisionStore } from "./decision-store";
import {
	type ReconcileOptions,
	type ReconcileReport,
	reconcileDecisions,
} from "./reconcile";
import { type SavedDecision, saveDecisionFile } from "./save";

// The same window the code index re-checks on, for the same reason: an MCP
// server outlives many checkouts, and without the git hooks — which are opt-in
// — a pull in the middle of a session used to keep serving the old branch's
// decisions for the life of the process while the code index moved on.
export const DECISIONS_RECHECK_AFTER_MS = 5000;

export interface DecisionSync {
	// Reconcile, then serve the cached report until the window passes.
	ensure(): ReconcileReport;
	// Re-read every present file and recompute, whatever the cache says.
	resync(): ReconcileReport;
	// Decisions this store holds whose file is on no branch checked out here.
	absent(): Array<{ id: string; title: string }>;
	save(input: CreateDecisionInput, context: SaveContext): SavedDecision;
}

export interface DecisionSyncOptions {
	cortexDir: string;
	db: Database;
	onReconciled?(report: ReconcileReport): void;
	now?: () => number;
}

export function openDecisionSync(options: DecisionSyncOptions): DecisionSync {
	return new ProjectDecisionSync(options);
}

// Unlike LazyCodeIndex this caches a value rather than a promise: reconciling
// is synchronous, so there is no in-flight pass for concurrent callers to
// share, and a failure simply leaves the cache empty for the next attempt.
class ProjectDecisionSync implements DecisionSync {
	private readonly dependencies: {
		store: DecisionStore;
		repository: DecisionSyncRepository;
	};
	private cached: ReconcileReport | null = null;
	private freshUntil = 0;

	constructor(private readonly options: DecisionSyncOptions) {
		this.dependencies = {
			store: DecisionStore.at(options.cortexDir),
			repository: new DecisionSyncRepository(options.db),
		};
	}

	ensure(): ReconcileReport {
		if (this.cached && this.now() < this.freshUntil) return this.cached;
		const fresh = this.reconcile({});
		this.cached = this.cached ? merged(this.cached, fresh) : fresh;
		return this.cached;
	}

	// The report accumulates across the process: the first ensure() may already
	// have moved decisions, and `cortex sync` has to name those too — otherwise
	// it reports "nothing to do" about work it just did on the way in.
	resync(): ReconcileReport {
		const earlier = this.cached;
		const fresh = this.reconcile({ full: true });
		this.cached = earlier ? merged(earlier, fresh) : fresh;
		return this.cached;
	}

	absent(): Array<{ id: string; title: string }> {
		return this.dependencies.repository.listAbsent();
	}

	// Saving reconciles as its last step, so the cache stays the truth about
	// this branch. The new decision is not in `imported` — it was inserted
	// here, not discovered — so the caller enqueues its embedding itself.
	save(input: CreateDecisionInput, context: SaveContext): SavedDecision {
		const saved = saveDecisionFile(this.dependencies, input, context);
		this.cached = saved.report;
		this.freshUntil = this.now() + DECISIONS_RECHECK_AFTER_MS;
		return saved;
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	private reconcile(options: ReconcileOptions): ReconcileReport {
		const report = reconcileDecisions(this.dependencies, options);
		this.freshUntil = this.now() + DECISIONS_RECHECK_AFTER_MS;
		this.options.onReconciled?.(report);
		return report;
	}
}

// Movements union; findings do not — a full pass recomputes every dangling
// link, superseded target and unreadable file from scratch, so the later
// report is the whole truth about them.
function merged(
	earlier: ReconcileReport,
	fresh: ReconcileReport,
): ReconcileReport {
	return {
		imported: union(earlier.imported, fresh.imported),
		edited: union(earlier.edited, fresh.edited),
		absent: union(earlier.absent, fresh.absent),
		restored: union(earlier.restored, fresh.restored),
		dangling: fresh.dangling,
		cyclic: fresh.cyclic,
		multiplyReplaced: fresh.multiplyReplaced,
		malformed: fresh.malformed,
		fenceBreaking: fresh.fenceBreaking,
	};
}

function union(earlier: string[], fresh: string[]): string[] {
	return [...new Set([...earlier, ...fresh])].sort();
}
