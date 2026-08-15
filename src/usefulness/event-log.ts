import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeAtomicallySync } from "@/support/atomic-write";
import { decodeEvents, encodeEvent, type UsefulnessEvent } from "./event";
import { isWithinHorizon, usefulnessScores } from "./score";

// Past this the log is rewritten keeping only the newest events. It is a
// ceiling on a rebuildable cache, not a budget anyone should feel.
const MAXIMUM_EVENTS = 5000;

// The local, gitignored sidecar behind the ranking tiebreaker. Every path here
// degrades to "no signal" instead of throwing: a query must never fail because
// a preference file could not be read or written.
export class UsefulnessEventLog {
	private cached: UsefulnessEvent[] | null = null;

	constructor(private readonly path: string) {}

	events(): UsefulnessEvent[] {
		this.cached ??= decodeEvents(readOrEmpty(this.path));
		return this.cached;
	}

	scores(now: Date = new Date()): Map<string, number> {
		return usefulnessScores(this.events(), now);
	}

	// Appending a short line is atomic enough across processes for a cache this
	// cheap to rebuild; compaction is the read-modify-write, and it is rare.
	append(events: UsefulnessEvent[], now: Date = new Date()): void {
		if (events.length === 0 || recordingDisabled()) return;
		const merged = [...this.events(), ...events];
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			appendFileSync(this.path, events.map(encodeEvent).join(""));
		} catch {
			return;
		}
		this.cached = merged;
		if (needsCompaction(merged, now)) this.compact(now);
	}

	// Re-reads before rewriting: another process may have appended events this
	// one never saw, and compaction must not be how they disappear.
	private compact(now: Date): void {
		const onDisk = decodeEvents(readOrEmpty(this.path));
		const kept = onDisk
			.filter((event) => isWithinHorizon(event, now))
			.slice(-MAXIMUM_EVENTS);
		if (kept.length === onDisk.length) return;
		try {
			writeAtomicallySync(this.path, kept.map(encodeEvent).join(""));
			this.cached = kept;
		} catch {}
	}
}

function needsCompaction(events: UsefulnessEvent[], now: Date): boolean {
	if (events.length > MAXIMUM_EVENTS) return true;
	const oldest = events[0];
	return oldest !== undefined && !isWithinHorizon(oldest, now);
}

function readOrEmpty(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function recordingDisabled(): boolean {
	return process.env.CORTEX_NO_USEFULNESS === "1";
}
