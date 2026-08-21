import type { UsefulnessEvent } from "./event";

// Mirrors the aggregation graphify does in reflect.py: a signed, time-decayed
// score, corroboration before anything is promoted, and the contested case
// (both signs on the same decision) settled by recency, which the decayed sum
// already does.
export const HALF_LIFE_DAYS = 30;
// One session cannot mint a preference: promoting on a single lucky hit is a
// bias that never expires, while a passed-over penalty is undone by the next
// use. The asymmetry is the point.
export const MINIMUM_CORROBORATING_SESSIONS = 2;
// The positive is an act the agent chose; the negative is inferred from what it
// did not do, so it carries a quarter of the weight.
export const PASSED_OVER_WEIGHT = 0.25;
// Six half-lives: an event past this contributes under 2% and is compacted away.
export const DECAY_HORIZON_DAYS = 180;

const MILLISECONDS_PER_DAY = 86_400_000;

// All a ranking consumer may know about the sidecar: a signed score per
// decision, and nothing about where it came from.
export interface UsefulnessRanking {
	scores(): Map<string, number>;
}

interface SessionSignals {
	shown: Map<string, string>;
	used: Map<string, string>;
}

export function usefulnessScores(
	events: UsefulnessEvent[],
	now: Date = new Date(),
): Map<string, number> {
	const sessions = groupBySession(events);
	const corroborated = corroboratedDecisions(sessions);
	const scores = new Map<string, number>();
	for (const signals of sessions.values()) {
		addUses(scores, signals, corroborated, now);
		addPassedOver(scores, signals, now);
	}
	return withoutZeros(scores);
}

export function ageInDays(at: string, now: Date): number {
	return (now.getTime() - Date.parse(at)) / MILLISECONDS_PER_DAY;
}

// The horizon measures distance from now in either direction. Clamping the
// weight of a future timestamp, as `decay` does, is only half the guard: an age
// that never grows is also an age that never reaches the horizon, so a clock a
// year ahead would otherwise mint an event that is both maximal and immortal —
// one no compaction could ever remove.
export function isWithinHorizon(event: UsefulnessEvent, now: Date): boolean {
	return Math.abs(ageInDays(event.at, now)) < DECAY_HORIZON_DAYS;
}

// A timestamp ahead of the clock weighs the same as one from this instant:
// clock skew across machines must not manufacture a signal stronger than any
// event can legitimately carry.
function decay(at: string, now: Date): number {
	return 0.5 ** (Math.max(0, ageInDays(at, now)) / HALF_LIFE_DAYS);
}

function groupBySession(
	events: UsefulnessEvent[],
): Map<string, SessionSignals> {
	const sessions = new Map<string, SessionSignals>();
	for (const event of events) {
		const signals = sessions.get(event.session) ?? emptySignals();
		sessions.set(event.session, signals);
		keepLatest(signals[event.kind], event);
	}
	return sessions;
}

function emptySignals(): SessionSignals {
	return { shown: new Map(), used: new Map() };
}

function keepLatest(
	entries: Map<string, string>,
	event: UsefulnessEvent,
): void {
	const recorded = entries.get(event.decision);
	if (recorded && recorded >= event.at) return;
	entries.set(event.decision, event.at);
}

function corroboratedDecisions(
	sessions: Map<string, SessionSignals>,
): Set<string> {
	const sessionsPerDecision = new Map<string, number>();
	for (const signals of sessions.values()) {
		for (const decision of signals.used.keys()) {
			sessionsPerDecision.set(
				decision,
				(sessionsPerDecision.get(decision) ?? 0) + 1,
			);
		}
	}
	return new Set(
		[...sessionsPerDecision.entries()]
			.filter(([, count]) => count >= MINIMUM_CORROBORATING_SESSIONS)
			.map(([decision]) => decision),
	);
}

function addUses(
	scores: Map<string, number>,
	signals: SessionSignals,
	corroborated: Set<string>,
	now: Date,
): void {
	for (const [decision, at] of signals.used) {
		if (!corroborated.has(decision)) continue;
		add(scores, decision, decay(at, now));
	}
}

// Only a session that acted on something can pass over anything else: a session
// that used no decision at all may simply have never got that far, and reading
// its silence as a verdict would penalize every decision the agent ever saw.
function addPassedOver(
	scores: Map<string, number>,
	signals: SessionSignals,
	now: Date,
): void {
	if (signals.used.size === 0) return;
	for (const [decision, at] of signals.shown) {
		if (signals.used.has(decision)) continue;
		add(scores, decision, -PASSED_OVER_WEIGHT * decay(at, now));
	}
}

function add(
	scores: Map<string, number>,
	decision: string,
	value: number,
): void {
	scores.set(decision, (scores.get(decision) ?? 0) + value);
}

function withoutZeros(scores: Map<string, number>): Map<string, number> {
	return new Map([...scores].filter(([, score]) => score !== 0));
}
