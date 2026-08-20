import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsefulnessEvent } from "@/usefulness/event";
import { UsefulnessEventLog } from "@/usefulness/event-log";

const NOW = new Date("2026-08-14T12:00:00.000Z");

function daysAgo(days: number): string {
	return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function event(
	decision: string,
	at = daysAgo(0),
	session = "s1",
): UsefulnessEvent {
	return { session, decision, kind: "used", at };
}

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-usefulness-"));
	path = join(dir, "local", "usefulness.jsonl");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.CORTEX_NO_USEFULNESS;
});

function lines(): string[] {
	return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

describe("UsefulnessEventLog", () => {
	test("a missing log reads as no signal at all", () => {
		const log = new UsefulnessEventLog(path);

		expect(log.events()).toEqual([]);
		expect(log.scores(NOW).size).toBe(0);
	});

	test("appending creates the directory and survives a reopen", () => {
		new UsefulnessEventLog(path).append([event("d1"), event("d2")], NOW);

		expect(new UsefulnessEventLog(path).events()).toHaveLength(2);
	});

	test("appending nothing writes nothing", () => {
		new UsefulnessEventLog(path).append([], NOW);

		expect(new UsefulnessEventLog(path).events()).toEqual([]);
	});

	test("a malformed line is dropped, the rest of the log is not", () => {
		const log = new UsefulnessEventLog(path);
		log.append([event("d1")], NOW);
		appendFileSync(path, 'not json\n{"session":"s1"}\n');
		log.append([event("d2")], NOW);

		expect(
			new UsefulnessEventLog(path).events().map((e) => e.decision),
		).toEqual(["d1", "d2"]);
	});

	test("scores are derived from what the log holds", () => {
		const log = new UsefulnessEventLog(path);
		log.append([event("d1"), event("d1", daysAgo(0), "s2")], NOW);

		expect(log.scores(NOW).get("d1")).toBeCloseTo(2, 5);
	});

	test("an unwritable path degrades to no signal instead of throwing", () => {
		const blocked = join(dir, "blocked");
		writeFileSync(blocked, "not a directory");
		const log = new UsefulnessEventLog(join(blocked, "usefulness.jsonl"));

		expect(() => log.append([event("d1")], NOW)).not.toThrow();
		expect(log.events()).toEqual([]);
	});

	test("CORTEX_NO_USEFULNESS=1 records nothing", () => {
		process.env.CORTEX_NO_USEFULNESS = "1";

		new UsefulnessEventLog(path).append([event("d1")], NOW);

		expect(new UsefulnessEventLog(path).events()).toEqual([]);
	});
});

describe("UsefulnessEventLog — compaction", () => {
	test("events past the horizon are dropped on the next append", () => {
		const log = new UsefulnessEventLog(path);
		log.append([event("old", daysAgo(200)), event("recent", daysAgo(10))], NOW);

		log.append([event("fresh")], NOW);

		expect(lines()).toHaveLength(2);
		expect(log.events().map((entry) => entry.decision)).toEqual([
			"recent",
			"fresh",
		]);
	});

	test("compaction keeps what another process appended meanwhile", () => {
		const log = new UsefulnessEventLog(path);
		log.append([event("old", daysAgo(200))], NOW);
		appendFileSync(path, `${JSON.stringify(event("elsewhere"))}\n`);

		log.append([event("fresh")], NOW);

		expect(
			new UsefulnessEventLog(path).events().map((e) => e.decision),
		).toEqual(["elsewhere", "fresh"]);
	});

	test("the log is capped, newest kept", () => {
		const log = new UsefulnessEventLog(path);
		const many = Array.from({ length: 5001 }, (_, index) => event(`d${index}`));

		log.append(many, NOW);

		expect(lines()).toHaveLength(5000);
		expect(log.events()[0]?.decision).toBe("d1");
	});

	test("a log within its limits is never rewritten", () => {
		const log = new UsefulnessEventLog(path);
		log.append([event("d1")], NOW);
		const before = readFileSync(path, "utf8");

		log.append([event("d2")], NOW);

		expect(readFileSync(path, "utf8").startsWith(before)).toBe(true);
	});
});
