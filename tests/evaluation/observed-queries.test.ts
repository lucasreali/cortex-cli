import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeEntry, searchQuery } from "@/querylog/entry";
import { defaultQueryLogPath } from "@/querylog/settings";
import { observedCases, unansweredCases } from "./observed-queries";

let cortexDir: string;

beforeEach(() => {
	cortexDir = join(mkdtempSync(join(tmpdir(), "cortex-observed-")), ".cortex");
});

afterEach(() => {
	rmSync(cortexDir, { recursive: true, force: true });
});

function writeLog(queries: Array<{ terms: string[]; ids: string[] }>): void {
	const path = defaultQueryLogPath(cortexDir);
	mkdirSync(join(cortexDir, "local"), { recursive: true });
	writeFileSync(
		path,
		queries
			.map((query) =>
				encodeEntry({
					...searchQuery(query.terms, false),
					session: "s1",
					at: "2026-08-14T12:00:00.000Z",
					results: query.ids.length,
					ids: query.ids,
				}),
			)
			.join(""),
	);
}

describe("evaluation fixtures from real traffic", () => {
	test("a project with no query log offers no cases", () => {
		expect(observedCases(cortexDir)).toEqual([]);
	});

	test("logged queries come back as candidate cases", () => {
		writeLog([
			{ terms: ["jwt", "login"], ids: ["d1", "d2"] },
			{ terms: ["nothing", "here"], ids: [] },
		]);

		expect(
			observedCases(cortexDir).map((observed) => ({
				query: observed.query,
				returned: observed.returned,
			})),
		).toEqual([
			{ query: "jwt login", returned: ["d1", "d2"] },
			{ query: "nothing here", returned: [] },
		]);
	});

	test("the unanswered ones are where a case is most likely missing", () => {
		writeLog([
			{ terms: ["jwt"], ids: ["d1"] },
			{ terms: ["rate", "limiting"], ids: [] },
		]);

		expect(
			unansweredCases(cortexDir).map((observed) => observed.query),
		).toEqual(["rate limiting"]);
	});
});
