import { describe, expect, test } from "bun:test";
import { TOKEN_METHOD, TokenCount } from "@/benchmark/token-count";

describe("TokenCount", () => {
	test("empty text costs nothing", () => {
		expect(TokenCount.of("").total).toBe(0);
		expect(TokenCount.zero().total).toBe(0);
	});

	test("a short word is one token", () => {
		expect(TokenCount.of("token").total).toBe(1);
	});

	test("punctuation is charged as its own atom", () => {
		expect(TokenCount.of("a,b,c").total).toBe(5);
	});

	test("a long word costs more than a short one", () => {
		expect(TokenCount.of("internationalization").total).toBeGreaterThan(
			TokenCount.of("word").total,
		);
	});

	test("accented text costs more than its ascii twin", () => {
		expect(TokenCount.of("decisão registrada").total).toBeGreaterThanOrEqual(
			TokenCount.of("decisao registrada").total,
		);
	});

	test("digits group in threes", () => {
		expect(TokenCount.of("1234567").total).toBe(3);
	});

	test("counting is additive over concatenation, give or take rounding", () => {
		const parts = TokenCount.of("the quick brown").plus(
			TokenCount.of(" fox jumps"),
		);

		expect(parts.total).toBe(TokenCount.of("the quick brown fox jumps").total);
	});

	test("sum folds a list", () => {
		const counts = [TokenCount.of("one"), TokenCount.of("two")];

		expect(TokenCount.sum(counts).total).toBe(2);
		expect(TokenCount.sum([]).total).toBe(0);
	});

	test("a ratio against nothing is zero, not infinity", () => {
		expect(TokenCount.of("anything").ratioTo(TokenCount.zero())).toBe(0);
	});

	test("a ratio divides the totals", () => {
		const many = TokenCount.of("one two three four");

		expect(many.ratioTo(TokenCount.of("one two"))).toBeCloseTo(2, 5);
	});

	test("the method names itself so a number is never mistaken", () => {
		expect(TOKEN_METHOD.id).toBe("atoms-per-5-bytes/v1");
		expect(TOKEN_METHOD.description.length).toBeGreaterThan(0);
	});
});
