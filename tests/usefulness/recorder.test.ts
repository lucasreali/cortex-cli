import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollingSession, sessionNamed } from "@tests/fixtures/session-source";
import { UsefulnessEventLog } from "@/usefulness/event-log";
import { UsefulnessRecorder } from "@/usefulness/recorder";

let dir: string;
let log: UsefulnessEventLog;
let recorder: UsefulnessRecorder;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-recorder-"));
	log = new UsefulnessEventLog(join(dir, "local", "usefulness.jsonl"));
	recorder = new UsefulnessRecorder(log, sessionNamed("session-1"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("UsefulnessRecorder", () => {
	test("records what was shown and what was used, keyed by session", () => {
		recorder.shown(["d1", "d2"]);
		recorder.used(["d2"]);

		expect(log.events()).toMatchObject([
			{ session: "session-1", decision: "d1", kind: "shown" },
			{ session: "session-1", decision: "d2", kind: "shown" },
			{ session: "session-1", decision: "d2", kind: "used" },
		]);
	});

	test("a decision shown again in the same session is one impression", () => {
		recorder.shown(["d1", "d1"]);
		recorder.shown(["d1", "d2"]);

		expect(log.events().map((event) => event.decision)).toEqual(["d1", "d2"]);
	});

	test("shown and used are claimed independently", () => {
		recorder.shown(["d1"]);
		recorder.used(["d1"]);
		recorder.used(["d1"]);

		expect(log.events().map((event) => event.kind)).toEqual(["shown", "used"]);
	});

	test("another session records the same decision again", () => {
		recorder.used(["d1"]);
		new UsefulnessRecorder(log, sessionNamed("session-2")).used(["d1"]);

		expect(log.events().map((event) => event.session)).toEqual([
			"session-1",
			"session-2",
		]);
	});

	// One recorder is what a server holds for as long as it is up. Before the
	// session could roll under it, the once-per-session claim made that server's
	// whole week one impression, so the tiebreaker's two-session threshold for
	// promoting anything was out of its reach — leaving it able to demote and
	// never to promote.
	test("one recorder spanning two conversations records both", () => {
		const rolling = new UsefulnessRecorder(
			log,
			rollingSession(["morning", "evening"]),
		);

		rolling.used(["d1"]);
		rolling.used(["d1"]);

		expect(log.events().map((event) => event.session)).toEqual([
			"morning",
			"evening",
		]);
		expect(log.scores().get("d1")).toBeGreaterThan(0);
	});
});
