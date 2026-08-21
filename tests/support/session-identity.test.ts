import { describe, expect, test } from "bun:test";
import { SESSION_IDLE_MS, SessionIdentity } from "@/support/session-identity";

describe("SessionIdentity", () => {
	test("traffic with no gap in it is one session", () => {
		const identity = new SessionIdentity();

		const ids = [0, 1_000, 60_000, SESSION_IDLE_MS - 1].map((at) =>
			identity.current(at),
		);

		expect(new Set(ids).size).toBe(1);
	});

	test("a gap as long as the idle window starts a new session", () => {
		const identity = new SessionIdentity();
		const first = identity.current(0);

		const second = identity.current(SESSION_IDLE_MS);

		expect(second).not.toBe(first);
	});

	test("the window is measured from the last call, not from the first", () => {
		const identity = new SessionIdentity();
		const first = identity.current(0);

		identity.current(SESSION_IDLE_MS - 1);

		expect(identity.current(2 * SESSION_IDLE_MS - 2)).toBe(first);
	});

	test("the real clock keeps a burst of calls in one session", () => {
		const identity = new SessionIdentity();

		expect(identity.current()).toBe(identity.current());
	});

	test("two identities are two sessions", () => {
		expect(new SessionIdentity().current()).not.toBe(
			new SessionIdentity().current(),
		);
	});
});
