import { describe, expect, test } from "bun:test";
import { meanScore, scoreRanking } from "./scoring";

describe("scoreRanking", () => {
	test("full hit at the first position scores perfect recall and rr", () => {
		expect(scoreRanking(["a"], ["a", "b", "c"])).toEqual({
			recall: 1,
			reciprocalRank: 1,
		});
	});

	test("first relevant at the second position halves the reciprocal rank", () => {
		expect(scoreRanking(["b"], ["a", "b", "c"])).toEqual({
			recall: 1,
			reciprocalRank: 0.5,
		});
	});

	test("partial recall counts only the expected ids present", () => {
		expect(scoreRanking(["a", "z"], ["a", "b", "c"])).toEqual({
			recall: 0.5,
			reciprocalRank: 1,
		});
	});

	test("no expected id in the ranking zeroes both metrics", () => {
		expect(scoreRanking(["z"], ["a", "b", "c"])).toEqual({
			recall: 0,
			reciprocalRank: 0,
		});
	});
});

describe("meanScore", () => {
	test("averages recall and reciprocal rank across cases", () => {
		expect(
			meanScore([
				{ recall: 1, reciprocalRank: 1 },
				{ recall: 0, reciprocalRank: 0.5 },
			]),
		).toEqual({ recall: 0.5, reciprocalRank: 0.75 });
	});

	test("an empty set of scores averages to zero", () => {
		expect(meanScore([])).toEqual({ recall: 0, reciprocalRank: 0 });
	});
});
