// A session is a conversation, not a process. A CLI process proves the two are
// the same by exiting; an MCP server up for a week does not, and the ranking
// tiebreaker needs two *distinct* sessions before it may promote a decision
// while one is enough to demote it — so a server that minted its identity once
// at startup could only ever accrue the negative signal.
//
// A gap with no traffic is the only conversation boundary visible from inside
// the server, and it is measured on a monotonic clock: a system time change,
// which is exactly what the sidecar's other clock-skew guards exist for, must
// not be able to mint or merge sessions.
export const SESSION_IDLE_MS = 30 * 60 * 1000;

// All a sidecar may know about the session: which one it is recording into
// right now. Whether that answer ever changes, and on what, is the identity's
// business and not the recorder's.
export interface SessionSource {
	current(): string;
}

export class SessionIdentity implements SessionSource {
	private id = Bun.randomUUIDv7();
	private touchedAt = elapsedMs();

	constructor(private readonly idleMs: number = SESSION_IDLE_MS) {}

	current(now: number = elapsedMs()): string {
		if (now - this.touchedAt >= this.idleMs) this.id = Bun.randomUUIDv7();
		this.touchedAt = now;
		return this.id;
	}
}

function elapsedMs(): number {
	return performance.now();
}
