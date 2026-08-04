import type { Database } from "bun:sqlite";
import { DecisionSyncRepository } from "@/storage/decision-sync-repository";
import { DecisionStore } from "./decision-store";
import type { ReconcileDependencies } from "./reconcile";

const BOOTSTRAP_MIGRATION = "decisions-present";

// The one-time export of a store that predates `.cortex/decisions/`, keyed off
// the migration that introduces it — the single moment a store is known to
// hold decisions that were never written to a file. From then on the file is
// written before the row, so it never runs again.
//
// It cannot key off a missing directory: git does not track empty ones, so a
// branch with no decisions carries no directory, and exporting there would
// scatter every other branch's decisions onto it.
export function exportDecisionsIfNeeded(
	cortexDir: string,
	db: Database,
	appliedMigrations: string[],
): void {
	if (!appliedMigrations.includes(BOOTSTRAP_MIGRATION)) return;
	exportExistingDecisions({
		store: DecisionStore.at(cortexDir),
		repository: new DecisionSyncRepository(db),
	});
}

export function exportExistingDecisions(
	dependencies: ReconcileDependencies,
): string[] {
	const files = dependencies.repository.listExportRows();
	for (const file of files) {
		dependencies.store.write(file);
	}
	return files.map((file) => file.id);
}
