import { describe, expect, test } from "bun:test";
import type { UsefulnessEvent, UsefulnessKind } from "@/usefulness/event";
import { isWithinHorizon, usefulnessScores } from "@/usefulness/score";

const NOW = new Date("2026-08-14T12:00:00.000Z");

function daysAgo(days: number): string {
	return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function event(
	session: string,
	decision: string,
	kind: UsefulnessKind,
	at = daysAgo(0),
): UsefulnessEvent {
	return { session, decision, kind, at };
}

describe("usefulnessScores — corroboration", () => {
	test("a single session using a decision promotes nothing", () => {
		const scores = usefulnessScores(
			[event("s1", "d1", "shown"), event("s1", "d1", "used")],
			NOW,
		);

		expect(scores.size).toBe(0);
	});

	test("two distinct sessions promote it", () => {
		const scores = usefulnessScores(
			[
				event("s1", "d1", "used"),
				event("s2", "d1", "used"),
				event("s3", "d1", "used"),
			],
			NOW,
		);

		expect(scores.get("d1")).toBeCloseTo(3, 5);
	});

	test("one session cannot corroborate itself by repeating", () => {
		const scores = usefulnessScores(
			[event("s1", "d1", "used"), event("s1", "d1", "used")],
			NOW,
		);

		expect(scores.size).toBe(0);
	});
});

describe("usefulnessScores — passed over", () => {
	test("a session that used something else penalizes what it skipped", () => {
		const scores = usefulnessScores(
			[
				event("s1", "d1", "shown"),
				event("s1", "d2", "shown"),
				event("s1", "d2", "used"),
			],
			NOW,
		);

		expect(scores.get("d1")).toBeCloseTo(-0.25, 5);
	});

	test("a session that used nothing penalizes nothing", () => {
		const scores = usefulnessScores(
			[event("s1", "d1", "shown"), event("s1", "d2", "shown")],
			NOW,
		);

		expect(scores.size).toBe(0);
	});

	test("a decision both shown and used in the same session is not skipped", () => {
		const scores = usefulnessScores(
			[
				event("s1", "d1", "shown"),
				event("s1", "d1", "used"),
				event("s2", "d1", "used"),
			],
			NOW,
		);

		expect(scores.get("d1")).toBeCloseTo(2, 5);
	});
});

describe("usefulnessScores — decay", () => {
	test("a use halves every 30 days", () => {
		const scores = usefulnessScores(
			[
				event("s1", "d1", "used", daysAgo(30)),
				event("s2", "d1", "used", daysAgo(60)),
			],
			NOW,
		);

		expect(scores.get("d1")).toBeCloseTo(0.75, 5);
	});

	test("a timestamp ahead of the clock weighs no more than a fresh one", () => {
		const scores = usefulnessScores(
			[
				event("s1", "d1", "used", daysAgo(-90)),
				event("s2", "d1", "used", daysAgo(0)),
			],
			NOW,
		);

		expect(scores.get("d1")).toBeCloseTo(2, 5);
	});

	test("fresh dead ends outweigh an old use — recency settles the contest", () => {
		const events = [
			event("s1", "d1", "used", daysAgo(90)),
			event("s2", "d1", "used", daysAgo(90)),
		];
		for (const session of ["s3", "s4", "s5", "s6"]) {
			events.push(
				event(session, "d1", "shown"),
				event(session, "d2", "shown"),
				event(session, "d2", "used"),
			);
		}

		const scores = usefulnessScores(events, NOW);

		expect(scores.get("d1")).toBeCloseTo(0.25 - 1, 5);
	});

	test("the same input and the same now give the same output", () => {
		const events = [
			event("s1", "d1", "used", daysAgo(3)),
			event("s2", "d1", "used", daysAgo(7)),
			event("s2", "d2", "shown", daysAgo(7)),
		];

		expect([...usefulnessScores(events, NOW)]).toEqual([
			...usefulnessScores(events, NOW),
		]);
	});
});

describe("usefulnessScores — bookkeeping", () => {
	test("a decision whose signals cancel out is left out entirely", () => {
		const events = [event("s1", "d1", "used"), event("s2", "d1", "used")];
		for (let session = 3; session <= 10; session++) {
			events.push(
				event(`s${session}`, "d1", "shown"),
				event(`s${session}`, "d2", "shown"),
				event(`s${session}`, "d2", "used"),
			);
		}

		const scores = usefulnessScores(events, NOW);

		expect(scores.has("d1")).toBe(false);
		expect(scores.get("d2")).toBeCloseTo(8, 5);
	});

	test("the horizon ends six half-lives out", () => {
		expect(isWithinHorizon(event("s1", "d1", "used", daysAgo(179)), NOW)).toBe(
			true,
		);
		expect(isWithinHorizon(event("s1", "d1", "used", daysAgo(181)), NOW)).toBe(
			false,
		);
	});

	// Its weight is already clamped to 1.0, so without a horizon in this
	// direction a clock-skewed event would be the strongest signal in the log
	// and no compaction could ever remove it.
	test("the horizon ends six half-lives out in the other direction too", () => {
		expect(isWithinHorizon(event("s1", "d1", "used", daysAgo(-1)), NOW)).toBe(
			true,
		);
		expect(isWithinHorizon(event("s1", "d1", "used", daysAgo(-181)), NOW)).toBe(
			false,
		);
	});
});
