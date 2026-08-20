import { describe, expect, test } from "bun:test";
import type { QueryLogEntry } from "@/querylog/entry";
import { searchQuery } from "@/querylog/entry";
import { RECENT_QUERY_WINDOW, recentQueries } from "@/querylog/stats";

function entry(results: number, index = 0): QueryLogEntry {
	return {
		...searchQuery([`q${index}`], false),
		session: "s1",
		at: "2026-08-14T12:00:00.000Z",
		results,
		ids: results === 0 ? [] : ["d1"],
	};
}

describe("recentQueries", () => {
	test("an empty log has nothing to report", () => {
		expect(recentQueries([])).toEqual({
			recorded: 0,
			considered: 0,
			empty: 0,
		});
	});

	test("misses are counted over the window, the total over the log", () => {
		const older = Array.from({ length: RECENT_QUERY_WINDOW }, () => entry(0));
		const recent = Array.from({ length: RECENT_QUERY_WINDOW }, (_, index) =>
			entry(index % 2, index),
		);

		expect(recentQueries([...older, ...recent])).toEqual({
			recorded: RECENT_QUERY_WINDOW * 2,
			considered: RECENT_QUERY_WINDOW,
			empty: RECENT_QUERY_WINDOW / 2,
		});
	});

	test("a log shorter than the window is reported whole", () => {
		expect(recentQueries([entry(0), entry(3, 1)])).toEqual({
			recorded: 2,
			considered: 2,
			empty: 1,
		});
	});
});
