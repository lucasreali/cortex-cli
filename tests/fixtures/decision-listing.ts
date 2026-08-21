import type { DecisionStore } from "@/decisions/decision-store";

// The ids a store lists, for assertions that are not about the listing itself
// failing: an unreadable directory is a state DecisionStore.list() reports, and
// a test that meant to write two files should say so loudly rather than compare
// against an empty array.
export function listedIds(store: DecisionStore): string[] {
	const listing = store.list();
	if (!listing.ok) throw new Error(`decisions directory: ${listing.reason}`);
	return listing.ids;
}
