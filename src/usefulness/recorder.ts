import type { UsefulnessKind } from "./event";
import type { UsefulnessEventLog } from "./event-log";

// One event per decision per kind per session: a decision returned by ten
// queries of the same session is one impression, not ten, which keeps both the
// score honest and the query path down to a rare short append.
export class UsefulnessRecorder {
	private readonly recorded = new Set<string>();

	constructor(
		private readonly log: UsefulnessEventLog,
		private readonly session: string,
	) {}

	shown(decisionIds: string[]): void {
		this.record("shown", decisionIds);
	}

	used(decisionIds: string[]): void {
		this.record("used", decisionIds);
	}

	private record(kind: UsefulnessKind, decisionIds: string[]): void {
		const at = new Date().toISOString();
		const fresh = decisionIds.filter((decision) => this.claim(kind, decision));
		this.log.append(
			fresh.map((decision) => ({ session: this.session, decision, kind, at })),
		);
	}

	private claim(kind: UsefulnessKind, decision: string): boolean {
		const key = `${kind}:${decision}`;
		if (this.recorded.has(key)) return false;
		this.recorded.add(key);
		return true;
	}
}
