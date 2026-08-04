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

export interface DecisionSync {
	// Reconcile once per process, then serve the cached report.
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

	constructor(private readonly options: DecisionSyncOptions) {
		this.dependencies = {
			store: DecisionStore.at(options.cortexDir),
			repository: new DecisionSyncRepository(options.db),
		};
	}

	ensure(): ReconcileReport {
		this.cached ??= this.reconcile({});
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
		return saved;
	}

	private reconcile(options: ReconcileOptions): ReconcileReport {
		const report = reconcileDecisions(this.dependencies, options);
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
		absent: union(earlier.absent, fresh.absent),
		restored: union(earlier.restored, fresh.restored),
		dangling: fresh.dangling,
		multiplyReplaced: fresh.multiplyReplaced,
		malformed: fresh.malformed,
	};
}

function union(earlier: string[], fresh: string[]): string[] {
	return [...new Set([...earlier, ...fresh])].sort();
}
