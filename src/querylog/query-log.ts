import { AppendOnlyLog } from "@/support/append-only-log";
import { decodeEntries, encodeEntry, type QueryLogEntry } from "./entry";
import type { QueryLogSettings } from "./settings";

// The log holds the verbatim text of what was asked, so the ceiling that means
// anything is bytes on disk, not rows: a thousand one-line questions and a
// thousand pasted stack traces are the same number of entries and three orders
// of magnitude apart. It is a ceiling on a local file that costs nothing to
// lose, not a retention policy — what the user keeps is decided by the opt-in,
// not by this number.
export const MAXIMUM_BYTES = 1024 * 1024;
// Compaction reads and rewrites the whole file, so it trims well under the
// ceiling instead of back to it: trimming to the trigger would compact again on
// the very next query, and every query after that.
export const COMPACTED_BYTES = MAXIMUM_BYTES / 2;

// The opt-in, gitignored record of what was asked here. Every path degrades to
// "no log" instead of throwing: a query must never fail because a file could
// not be written.
export class QueryLog {
	private readonly file: AppendOnlyLog;

	constructor(private readonly settings: QueryLogSettings) {
		this.file = new AppendOnlyLog(settings.path);
	}

	get enabled(): boolean {
		return this.settings.enabled;
	}

	get path(): string {
		return this.settings.path;
	}

	// One short line, appended without reading first: the query path pays a
	// single write, never the cost of loading the log it writes to.
	append(entry: QueryLogEntry): void {
		if (!this.settings.enabled) return;
		if (!this.file.append(encodeEntry(entry))) return;
		this.compactWhenDue();
	}

	// Reading is not recording, so it stays available while the log is off:
	// that is how doctor can say a log an earlier opt-in left behind is still
	// on disk, instead of pretending nothing was ever recorded.
	entries(): QueryLogEntry[] {
		return decodeEntries(this.file.read());
	}

	// Asked of the file, never of a counter this instance keeps: a CLI process
	// makes one query and exits, so a per-instance counter would leave the
	// ceiling unenforced on every surface but the long-lived server.
	private compactWhenDue(): void {
		if (this.file.sizeInBytes() <= MAXIMUM_BYTES) return;
		this.file.compact(newestWithinBudget);
	}
}

function newestWithinBudget(text: string): string {
	const lines = decodeEntries(text).map(encodeEntry);
	return lines.slice(firstLineWithinBudget(lines)).join("");
}

function firstLineWithinBudget(lines: string[]): number {
	let budget = COMPACTED_BYTES;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		budget -= Buffer.byteLength(lines[index] ?? "");
		if (budget < 0) return index + 1;
	}
	return 0;
}
