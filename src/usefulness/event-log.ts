import { AppendOnlyLog } from "@/support/append-only-log";
import { decodeEvents, encodeEvent, type UsefulnessEvent } from "./event";
import { isWithinHorizon, usefulnessScores } from "./score";

// Past this the log is rewritten keeping only the newest events. It is a
// ceiling on a rebuildable cache, not a budget anyone should feel.
const MAXIMUM_EVENTS = 5000;

// The local, gitignored sidecar behind the ranking tiebreaker. Every path here
// degrades to "no signal" instead of throwing: a query must never fail because
// a preference file could not be read or written.
export class UsefulnessEventLog {
	private readonly file: AppendOnlyLog;
	private cached: UsefulnessEvent[] | null = null;

	constructor(path: string) {
		this.file = new AppendOnlyLog(path);
	}

	events(): UsefulnessEvent[] {
		this.cached ??= decodeEvents(this.file.read());
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
		if (!this.file.append(events.map(encodeEvent).join(""))) return;
		this.cached = merged;
		if (needsCompaction(merged, now)) this.compact(now);
	}

	// A compaction puts back whatever another process appended while it ran, so
	// what is on disk afterwards is no longer what this instance believed. The
	// cache is dropped rather than guessed at, and the next read rebuilds it.
	private compact(now: Date): void {
		this.file.compact((text) => newestWithinHorizon(text, now));
		this.cached = null;
	}
}

function newestWithinHorizon(text: string, now: Date): string {
	return decodeEvents(text)
		.filter((event) => isWithinHorizon(event, now))
		.slice(-MAXIMUM_EVENTS)
		.map(encodeEvent)
		.join("");
}

function needsCompaction(events: UsefulnessEvent[], now: Date): boolean {
	if (events.length > MAXIMUM_EVENTS) return true;
	const oldest = events[0];
	return oldest !== undefined && !isWithinHorizon(oldest, now);
}

function recordingDisabled(): boolean {
	return process.env.CORTEX_NO_USEFULNESS === "1";
}
