import type { ReconcileDependencies } from "./reconcile";

// The one-time export of a store that predates `.cortex/decisions/`. It runs
// when migration 004 is applied — the single moment a store is known to hold
// decisions that were never written to a file — and never again, because from
// then on the file is written before the row.
//
// It cannot key off a missing directory: git does not track empty ones, so a
// branch with no decisions carries no directory, and exporting there would
// scatter every other branch's decisions onto it.
export function exportExistingDecisions(
	dependencies: ReconcileDependencies,
): string[] {
	const files = dependencies.repository.listExportRows();
	for (const file of files) {
		dependencies.store.write(file);
	}
	return files.map((file) => file.id);
}
