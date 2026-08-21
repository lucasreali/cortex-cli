import type { SessionSource } from "@/support/session-identity";
import type { UsefulnessKind } from "./event";
import type { UsefulnessEventLog } from "./event-log";

// One event per decision per kind per session: a decision returned by ten
// queries of the same session is one impression, not ten, which keeps both the
// score honest and the query path down to a rare short append.
export class UsefulnessRecorder {
	private readonly claimed = new ClaimsPerSession();

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
		const session = this.session.current();
		const at = new Date().toISOString();
		const fresh = decisionIds.filter((decision) =>
			this.claimed.claim(session, `${kind}:${decision}`),
		);
		this.log.append(fresh.map((decision) => ({ session, decision, kind, at })));
	}
}

// The claims belong to the session, not to the process holding them: a server
// that rolls into a new conversation has to be able to record the same decision
// again, and dropping the previous session's keys is also what keeps the set
// from growing for as long as the server is up.
class ClaimsPerSession {
	private session = "";
	private keys = new Set<string>();

	claim(session: string, key: string): boolean {
		if (session !== this.session) this.startOver(session);
		if (this.keys.has(key)) return false;
		this.keys.add(key);
		return true;
	}

	private startOver(session: string): void {
		this.session = session;
		this.keys = new Set();
	}
}
