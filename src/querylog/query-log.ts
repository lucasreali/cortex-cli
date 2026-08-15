import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeAtomicallySync } from "@/support/atomic-write";
import { decodeEntries, encodeEntry, type QueryLogEntry } from "./entry";
import type { QueryLogSettings } from "./settings";

// A ceiling on a local file that costs nothing to lose, not a retention policy:
// what the user keeps is decided by the opt-in, not by this number.
const MAXIMUM_ENTRIES = 2000;
// Compaction is the only read on the write path, so it is amortized: a hundred
// queries pay for one pass over the log.
const APPENDS_BETWEEN_COMPACTIONS = 100;

// The opt-in, gitignored record of what was asked here. Every path degrades to
// "no log" instead of throwing: a query must never fail because a file could
// not be written.
export class QueryLog {
	private appendsSinceCompaction = 0;

	constructor(private readonly settings: QueryLogSettings) {}

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
		try {
			mkdirSync(dirname(this.settings.path), { recursive: true });
			appendFileSync(this.settings.path, encodeEntry(entry));
		} catch {
			return;
		}
		this.compactWhenDue();
	}

	// Reading is not recording, so it stays available while the log is off:
	// that is how doctor can say a log an earlier opt-in left behind is still
	// on disk, instead of pretending nothing was ever recorded.
	entries(): QueryLogEntry[] {
		return decodeEntries(readOrEmpty(this.settings.path));
	}

	private compactWhenDue(): void {
		this.appendsSinceCompaction += 1;
		if (this.appendsSinceCompaction < APPENDS_BETWEEN_COMPACTIONS) return;
		this.appendsSinceCompaction = 0;
		this.compact();
	}

	// Re-reads before rewriting: another process may have appended queries this
	// one never saw, and compaction must not be how they disappear.
	private compact(): void {
		const onDisk = this.entries();
		if (onDisk.length <= MAXIMUM_ENTRIES) return;
		const kept = onDisk.slice(-MAXIMUM_ENTRIES);
		try {
			writeAtomicallySync(this.settings.path, kept.map(encodeEntry).join(""));
		} catch {}
	}
}

function readOrEmpty(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}
