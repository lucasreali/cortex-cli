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

	resync(): ReconcileReport {
		this.cached = this.reconcile({ full: true });
		return this.cached;
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
