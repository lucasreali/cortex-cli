import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionNamed } from "@tests/fixtures/session-source";
import {
	contextQuery,
	encodeEntry,
	type QueryLogEntry,
	searchQuery,
} from "@/querylog/entry";
import { COMPACTED_BYTES, MAXIMUM_BYTES, QueryLog } from "@/querylog/query-log";
import { QueryRecorder } from "@/querylog/recorder";
import {
	DISABLE_VARIABLE,
	ENABLE_VARIABLE,
	PATH_VARIABLE,
	QueryLogSettings,
} from "@/querylog/settings";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-querylog-"));
	path = join(dir, "local", "queries.jsonl");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function openLog(enabled = true, at = path): QueryLog {
	return new QueryLog(
		QueryLogSettings.from(dir, {
			...(enabled ? { [ENABLE_VARIABLE]: "1" } : {}),
			[PATH_VARIABLE]: at,
		}),
	);
}

function entry(query: string, results = 1): QueryLogEntry {
	return {
		...searchQuery([query], false),
		session: "s1",
		at: "2026-08-14T12:00:00.000Z",
		results,
		ids: results === 0 ? [] : ["d1"],
	};
}

function lines(): string[] {
	return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

describe("QueryLog", () => {
	test("a log that was never enabled writes nothing", () => {
		const log = openLog(false);

		log.append(entry("jwt"));

		expect(log.enabled).toBe(false);
		expect(log.entries()).toEqual([]);
	});

	test("the disable flag wins even with the enable flag set", () => {
		const log = new QueryLog(
			QueryLogSettings.from(dir, {
				[ENABLE_VARIABLE]: "1",
				[DISABLE_VARIABLE]: "1",
				[PATH_VARIABLE]: path,
			}),
		);

		log.append(entry("jwt"));

		expect(log.entries()).toEqual([]);
	});

	test("an enabled log creates its directory and survives a reopen", () => {
		openLog().append(entry("jwt"));

		expect(
			openLog()
				.entries()
				.map((line) => line.query),
		).toEqual(["jwt"]);
	});

	test("the log reads back everything it was given", () => {
		const log = openLog();

		log.append({
			...contextQuery("como autenticamos?", "auth"),
			session: "s2",
			at: "2026-08-14T12:00:00.000Z",
			results: 2,
			ids: ["d1", "d2"],
		});

		expect(log.entries()[0]).toEqual({
			surface: "get_context",
			query: "como autenticamos?",
			terms: [],
			exact: false,
			module: "auth",
			session: "s2",
			at: "2026-08-14T12:00:00.000Z",
			results: 2,
			ids: ["d1", "d2"],
		});
	});

	test("a malformed line is dropped, the rest of the log is not", () => {
		const log = openLog();
		log.append(entry("first"));
		appendFileSync(path, 'not json\n{"session":"s1"}\n');
		log.append(entry("second"));

		expect(log.entries().map((line) => line.query)).toEqual([
			"first",
			"second",
		]);
	});

	test("an unwritable path degrades to no log instead of throwing", () => {
		const blocked = join(dir, "blocked");
		writeFileSync(blocked, "not a directory");
		const log = openLog(true, join(blocked, "queries.jsonl"));

		expect(() => log.append(entry("jwt"))).not.toThrow();
		expect(log.entries()).toEqual([]);
	});

	test("a log left behind stays readable after recording is turned off", () => {
		openLog().append(entry("jwt"));

		const off = openLog(false);

		expect(off.enabled).toBe(false);
		expect(off.entries()).toHaveLength(1);
		expect(off.path).toBe(path);
	});
});

describe("QueryLog — compaction", () => {
	function seedBeyondTheCeiling(): void {
		mkdirSync(join(dir, "local"), { recursive: true });
		const line = encodeEntry(entry("seeded"));
		const count = Math.ceil(MAXIMUM_BYTES / line.length) + 1;
		writeFileSync(path, line.repeat(count));
	}

	function appendMany(log: QueryLog, count: number): void {
		for (let index = 0; index < count; index += 1) {
			log.append(entry(`fresh-${index}`));
		}
	}

	function sizeOnDisk(): number {
		return statSync(path).size;
	}

	// The one a per-instance counter could never do: a CLI process makes a
	// single query and exits, so the ceiling has to be read off the file.
	test("one query from a fresh process caps a log that process never wrote", () => {
		seedBeyondTheCeiling();
		const log = openLog();

		log.append(entry("the only query this process makes"));

		expect(sizeOnDisk()).toBeLessThanOrEqual(COMPACTED_BYTES);
		expect(log.entries().at(-1)?.query).toBe(
			"the only query this process makes",
		);
	});

	test("compaction trims under the ceiling, so the next query does not repeat it", () => {
		seedBeyondTheCeiling();
		const log = openLog();
		log.append(entry("first"));
		const compacted = readFileSync(path, "utf8");

		log.append(entry("second"));

		expect(readFileSync(path, "utf8")).toBe(
			compacted + encodeEntry(entry("second")),
		);
	});

	test("an entry larger than the whole budget does not wedge the log", () => {
		const log = openLog();

		log.append(entry("x".repeat(MAXIMUM_BYTES + 1)));
		log.append(entry("after"));

		expect(sizeOnDisk()).toBeLessThanOrEqual(COMPACTED_BYTES);
		expect(log.entries().map((line) => line.query)).toEqual(["after"]);
	});

	test("a log within its limits is never rewritten", () => {
		const log = openLog();
		log.append(entry("first"));
		const before = readFileSync(path, "utf8");

		appendMany(log, 100);

		expect(readFileSync(path, "utf8").startsWith(before)).toBe(true);
		expect(lines()).toHaveLength(101);
	});
});

describe("QueryRecorder", () => {
	test("every query is a line, the same query twice is two", () => {
		const log = openLog();
		const recorder = new QueryRecorder(log, sessionNamed("session-1"));

		recorder.record(searchQuery(["jwt"], false), ["d1"]);
		recorder.record(searchQuery(["jwt"], false), ["d1"]);

		expect(log.entries()).toHaveLength(2);
		expect(log.entries()[0]?.session).toBe("session-1");
	});

	test("the full result count is kept, only the head of the ids", () => {
		const log = openLog();
		const ids = Array.from({ length: 25 }, (_, index) => `d${index}`);

		new QueryRecorder(log, sessionNamed("session-1")).record(
			searchQuery(["jwt"], true),
			ids,
		);

		const recorded = log.entries()[0];
		expect(recorded?.results).toBe(25);
		expect(recorded?.ids).toHaveLength(10);
		expect(recorded?.exact).toBe(true);
	});

	test("a query that returned nothing is recorded as such", () => {
		const log = openLog();

		new QueryRecorder(log, sessionNamed("session-1")).record(
			searchQuery(["nope"], false),
			[],
		);

		expect(log.entries()[0]?.results).toBe(0);
	});

	test("recording into a disabled log costs nothing and throws nothing", () => {
		const log = openLog(false);

		expect(() =>
			new QueryRecorder(log, sessionNamed("session-1")).record(
				contextQuery("x", null),
				[],
			),
		).not.toThrow();
		expect(log.entries()).toEqual([]);
	});
});
