import { describe, expect, test } from "bun:test";
import {
	contextQuery,
	decodeEntries,
	encodeEntry,
	type QueryLogEntry,
	searchQuery,
} from "@/querylog/entry";

function entryOf(overrides: Partial<QueryLogEntry> = {}): QueryLogEntry {
	return {
		...searchQuery(["jwt", "login"], false),
		session: "s1",
		at: "2026-08-14T12:00:00.000Z",
		results: 1,
		ids: ["d1"],
		...overrides,
	};
}

describe("query entries", () => {
	test("an intent is a query with no terms", () => {
		expect(contextQuery("how do we paginate?", "api")).toEqual({
			surface: "get_context",
			query: "how do we paginate?",
			terms: [],
			exact: false,
			module: "api",
		});
	});

	test("a term search carries both the terms and the joined text", () => {
		expect(searchQuery(["jwt", "login"], true)).toEqual({
			surface: "search",
			query: "jwt login",
			terms: ["jwt", "login"],
			exact: true,
			module: null,
		});
	});

	test("encoding is one JSON line per entry", () => {
		const encoded = encodeEntry(entryOf());

		expect(encoded.endsWith("\n")).toBe(true);
		expect(decodeEntries(encoded)).toEqual([entryOf()]);
	});

	test("blank lines and junk are skipped, valid neighbours survive", () => {
		const text = `${encodeEntry(entryOf())}\n  \nnot json\n${encodeEntry(
			entryOf({ query: "second" }),
		)}`;

		expect(decodeEntries(text).map((entry) => entry.query)).toEqual([
			"jwt login",
			"second",
		]);
	});

	test("a line missing a field, or with the wrong shape, is not an entry", () => {
		const wrong = [
			JSON.stringify({ ...entryOf(), surface: "prompt_hook" }),
			JSON.stringify({ ...entryOf(), at: "not a date" }),
			JSON.stringify({ ...entryOf(), results: "many" }),
			JSON.stringify({ ...entryOf(), terms: "jwt" }),
			JSON.stringify({ ...entryOf(), ids: null }),
			JSON.stringify({ ...entryOf(), query: 7 }),
			JSON.stringify({ ...entryOf(), session: null }),
			"null",
		].join("\n");

		expect(decodeEntries(wrong)).toEqual([]);
	});
});
