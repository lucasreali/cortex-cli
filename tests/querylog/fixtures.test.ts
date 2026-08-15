import { describe, expect, test } from "bun:test";
import {
	type AskedQuery,
	contextQuery,
	type QueryLogEntry,
	searchQuery,
} from "@/querylog/entry";
import { observedQueries } from "@/querylog/fixtures";

function asked(query: AskedQuery, at: string, ids: string[]): QueryLogEntry {
	return { ...query, session: "s1", at, results: ids.length, ids };
}

describe("observedQueries", () => {
	test("an empty log yields no fixtures", () => {
		expect(observedQueries([])).toEqual([]);
	});

	test("the same question is one fixture, counted", () => {
		const entries = [
			asked(searchQuery(["jwt"], false), "2026-08-01T10:00:00.000Z", ["d1"]),
			asked(searchQuery(["JWT"], false), "2026-08-02T10:00:00.000Z", ["d2"]),
		];

		const [fixture] = observedQueries(entries);

		expect(fixture?.occurrences).toBe(2);
		expect(fixture?.lastAskedAt).toBe("2026-08-02T10:00:00.000Z");
	});

	test("the newest run describes the ranking as it stands", () => {
		const entries = [
			asked(searchQuery(["jwt"], false), "2026-08-01T10:00:00.000Z", ["d1"]),
			asked(searchQuery(["jwt"], false), "2026-08-02T10:00:00.000Z", []),
		];

		expect(observedQueries(entries)[0]?.returned).toEqual([]);
	});

	test("exactness and surface separate otherwise identical questions", () => {
		const entries = [
			asked(searchQuery(["jwt"], false), "2026-08-01T10:00:00.000Z", ["d1"]),
			asked(searchQuery(["jwt"], true), "2026-08-01T10:00:00.000Z", ["d1"]),
			asked(contextQuery("jwt", null), "2026-08-01T10:00:00.000Z", ["d1"]),
		];

		expect(observedQueries(entries)).toHaveLength(3);
	});

	test("fixtures come back by how often they were asked, newest first on a tie", () => {
		const entries = [
			asked(searchQuery(["rare"], false), "2026-08-03T10:00:00.000Z", ["d1"]),
			asked(searchQuery(["often"], false), "2026-08-01T10:00:00.000Z", ["d1"]),
			asked(searchQuery(["often"], false), "2026-08-01T11:00:00.000Z", ["d1"]),
			asked(searchQuery(["older"], false), "2026-08-02T10:00:00.000Z", ["d1"]),
		];

		expect(observedQueries(entries).map((fixture) => fixture.query)).toEqual([
			"often",
			"rare",
			"older",
		]);
	});

	test("a fixture id is stable for the same question", () => {
		const first = observedQueries([
			asked(searchQuery(["jwt"], false), "2026-08-01T10:00:00.000Z", ["d1"]),
		]);
		const second = observedQueries([
			asked(searchQuery([" JWT "], false), "2026-08-05T10:00:00.000Z", []),
		]);

		expect(first[0]?.id).toBe(second[0]?.id ?? "");
		expect(first[0]?.id).toHaveLength(12);
	});
});
