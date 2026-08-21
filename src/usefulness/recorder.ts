import type { SessionSource } from "@/support/session-identity";
import type { UsefulnessKind } from "./event";
import type { UsefulnessEventLog } from "./event-log";

// One event per decision per kind per session: a decision returned by ten
// queries of the same session is one impression, not ten, which keeps both the
// score honest and the query path down to a rare short append.
export class UsefulnessRecorder {
	private claimed = new Set<string>();
	private claimedFor = "";

	constructor(
		private readonly log: UsefulnessEventLog,
		private readonly session: SessionSource,
	) {}

	shown(decisionIds: string[]): void {
		this.record("shown", decisionIds);
	}

	used(decisionIds: string[]): void {
		this.record("used", decisionIds);
	}

	private record(kind: UsefulnessKind, decisionIds: string[]): void {
		const session = this.currentSession();
		const at = new Date().toISOString();
		const fresh = decisionIds.filter((decision) =>
			this.claim(`${kind}:${decision}`),
		);
		this.log.append(fresh.map((decision) => ({ session, decision, kind, at })));
	}

	// The claims belong to the session, not to the recorder holding them: one
	// recorder is what a server keeps for as long as it is up, so a conversation
	// that starts under it has to be able to record the same decision again.
	// Dropping the previous session's keys is also what keeps the set from
	// growing for the life of the process.
	private currentSession(): string {
		const session = this.session.current();
		if (session === this.claimedFor) return session;
		this.claimedFor = session;
		this.claimed = new Set();
		return session;
	}

	private claim(key: string): boolean {
		if (this.claimed.has(key)) return false;
		this.claimed.add(key);
		return true;
	}
}
