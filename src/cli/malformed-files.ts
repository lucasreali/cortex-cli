import type { MalformedDecisionFile } from "@/decisions/reconcile";

// One line per unreadable file turns a corrupt checkout into a wall that buries
// every other finding. Five is enough to see whether the failures share a cause
// — one directory, one reason — and the remainder is stated rather than dropped,
// because a cap nobody is told about is how a broken file goes unfixed forever.
const LISTED_MALFORMED_FILES = 5;

export function boundedMalformedLines(
	malformed: MalformedDecisionFile[],
	describe: (entry: MalformedDecisionFile) => string,
): string[] {
	const listed = malformed.slice(0, LISTED_MALFORMED_FILES).map(describe);
	const omitted = malformed.length - listed.length;
	if (omitted === 0) return listed;
	return [...listed, omissionLine(omitted)];
}

// `cortex sync --json` prints the reconcile report whole, so the uncapped list
// is always one command away.
function omissionLine(omitted: number): string {
	return (
		`... and ${omitted} more unreadable decision file(s) — ` +
		"run: cortex sync --json for the full list"
	);
}
