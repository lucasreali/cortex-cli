import type { SkippedSource } from "@/indexer/source-walker";

// Same reasoning as cli/malformed-files.ts: five is enough to see whether the
// skips share a cause — one directory, one reason — and the remainder is stated
// rather than dropped, because a cap nobody is told about is how an unreadable
// file goes unnoticed until get_impact quietly answers "no code impact".
const LISTED_SKIPPED_SOURCES = 5;

export function boundedSkippedLines(skipped: SkippedSource[]): string[] {
	const listed = skipped.slice(0, LISTED_SKIPPED_SOURCES).map(describe);
	const omitted = skipped.length - listed.length;
	if (omitted === 0) return listed;
	return [...listed, `... and ${omitted} more skipped source file(s)`];
}

function describe(entry: SkippedSource): string {
	return `source skipped: ${entry.path} — ${entry.reason}`;
}
