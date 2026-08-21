import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	contextQuery,
	encodeEntry,
	type QueryLogEntry,
	searchQuery,
} from "@/querylog/entry";
import { QueryLog } from "@/querylog/query-log";
import { QueryRecorder } from "@/querylog/recorder";
import {
	DISABLE_VARIABLE,
	ENABLE_VARIABLE,
	PATH_VARIABLE,
	QueryLogSettings,
} from "@/querylog/settings";

const MAXIMUM_ENTRIES = 2000;
const APPENDS_BETWEEN_COMPACTIONS = 100;

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
	function seed(count: number): void {
		mkdirSync(join(dir, "local"), { recursive: true });
		writeFileSync(
			path,
			Array.from({ length: count }, (_, index) =>
				encodeEntry(entry(`seeded-${index}`)),
			).join(""),
		);
	}

	function appendMany(log: QueryLog, count: number): void {
		for (let index = 0; index < count; index += 1) {
			log.append(entry(`fresh-${index}`));
		}
	}

	test("an oversized log is capped at the next compaction, newest kept", () => {
		seed(MAXIMUM_ENTRIES + 500);
		const log = openLog();

		appendMany(log, APPENDS_BETWEEN_COMPACTIONS);

		expect(lines()).toHaveLength(MAXIMUM_ENTRIES);
		expect(log.entries().at(-1)?.query).toBe(
			`fresh-${APPENDS_BETWEEN_COMPACTIONS - 1}`,
		);
	});

	test("compaction keeps what another process appended meanwhile", () => {
		seed(MAXIMUM_ENTRIES + 1);
		const log = openLog();
		appendFileSync(path, encodeEntry(entry("elsewhere")));

		appendMany(log, APPENDS_BETWEEN_COMPACTIONS);

		expect(log.entries().map((line) => line.query)).toContain("elsewhere");
	});

	test("a log within its limits is never rewritten", () => {
		const log = openLog();
		log.append(entry("first"));
		const before = readFileSync(path, "utf8");

		appendMany(log, APPENDS_BETWEEN_COMPACTIONS);

		expect(readFileSync(path, "utf8").startsWith(before)).toBe(true);
		expect(lines()).toHaveLength(APPENDS_BETWEEN_COMPACTIONS + 1);
	});
});

describe("QueryRecorder", () => {
	test("every query is a line, the same query twice is two", () => {
		const log = openLog();
		const recorder = new QueryRecorder(log, "session-1");

		recorder.record(searchQuery(["jwt"], false), ["d1"]);
		recorder.record(searchQuery(["jwt"], false), ["d1"]);

		expect(log.entries()).toHaveLength(2);
		expect(log.entries()[0]?.session).toBe("session-1");
	});

	test("the full result count is kept, only the head of the ids", () => {
		const log = openLog();
		const ids = Array.from({ length: 25 }, (_, index) => `d${index}`);

		new QueryRecorder(log, "session-1").record(searchQuery(["jwt"], true), ids);

		const recorded = log.entries()[0];
		expect(recorded?.results).toBe(25);
		expect(recorded?.ids).toHaveLength(10);
		expect(recorded?.exact).toBe(true);
	});

	test("a query that returned nothing is recorded as such", () => {
		const log = openLog();

		new QueryRecorder(log, "session-1").record(
			searchQuery(["nope"], false),
			[],
		);

		expect(log.entries()[0]?.results).toBe(0);
	});

	test("recording into a disabled log costs nothing and throws nothing", () => {
		const log = openLog(false);

		expect(() =>
			new QueryRecorder(log, "session-1").record(contextQuery("x", null), []),
		).not.toThrow();
		expect(log.entries()).toEqual([]);
	});
});
