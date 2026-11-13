import { AppendOnlyLog } from "@/support/append-only-log";
import { parseJsonOrNull } from "@/support/json";

export interface SessionSummary {
	id: string;
	summary: string;
	createdAt: string;
}

interface SummaryLine {
	session: string;
	summary: string;
	at: string;
}

// Past this the log is rewritten with only the latest summary per session.
const MAXIMUM_BYTES = 1024 * 1024;
const KEPT_SESSIONS = 200;

// The "Open" section of a session summary is the only record of unfinished
// work the next session can recover, and it used to live in decisions.db —
// the database every error message calls a rebuildable cache, and tells the
// user to delete. Following that advice erased every narrative. It lives here
// now, beside the other per-machine sidecars under `.cortex/local/`, where
// nothing rebuilds over it; the rows decisions.db still holds are read as the
// older half of the history and never written again.
export class SessionSummaryLog {
	private readonly log: AppendOnlyLog;

	constructor(path: string) {
		this.log = new AppendOnlyLog(path);
	}

	// Each call is the session's whole narrative, so the latest line wins.
	record(sessionId: string, summary: string, now = new Date()): boolean {
		const line: SummaryLine = {
			session: sessionId,
			summary,
			at: now.toISOString(),
		};
		const written = this.log.append(`${JSON.stringify(line)}\n`);
		if (this.log.sizeInBytes() > MAXIMUM_BYTES) this.log.compact(compacted);
		return written;
	}

	// Newest session first. Session ids are UUIDv7, so their order is time
	// order whichever half of the history an entry came from.
	list(limit: number, legacy: SessionSummary[] = []): SessionSummary[] {
		const latest = new Map(legacy.map((entry) => [entry.id, entry]));
		for (const line of parsed(this.log.read())) {
			latest.set(line.session, {
				id: line.session,
				summary: line.summary,
				createdAt: line.at,
			});
		}
		return [...latest.values()]
			.sort((one, other) => other.id.localeCompare(one.id))
			.slice(0, limit);
	}
}

function parsed(text: string): SummaryLine[] {
	return text.split("\n").flatMap((raw) => {
		const line = parseJsonOrNull<Partial<SummaryLine>>(raw);
		if (
			typeof line?.session !== "string" ||
			typeof line.summary !== "string" ||
			typeof line.at !== "string"
		) {
			return [];
		}
		return [line as SummaryLine];
	});
}

function compacted(text: string): string {
	const latest = new Map(parsed(text).map((line) => [line.session, line]));
	return [...latest.values()]
		.sort((one, other) => other.session.localeCompare(one.session))
		.slice(0, KEPT_SESSIONS)
		.reverse()
		.map((line) => `${JSON.stringify(line)}\n`)
		.join("");
}
