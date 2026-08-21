import { describe, expect, test } from "bun:test";
import { DecisionCorpus } from "@/benchmark/decision-corpus";
import { RepositoryCorpus } from "@/benchmark/repository-corpus";
import { TokenCount } from "@/benchmark/token-count";

const ENTRIES = [
	{ id: "a", text: "the vector leg degrades to full text search" },
	{ id: "b", text: "hooks reconcile after a merge" },
	{ id: "c", text: "one" },
];

describe("DecisionCorpus", () => {
	test("counts every decision it was given", () => {
		const corpus = new DecisionCorpus(ENTRIES);

		expect(corpus.decisions).toBe(3);
		expect(corpus.total.total).toBe(
			TokenCount.sum(ENTRIES.map((entry) => TokenCount.of(entry.text))).total,
		);
	});

	test("charges only the decisions an answer names", () => {
		const corpus = new DecisionCorpus(ENTRIES);

		expect(corpus.tokensOf(["c"]).total).toBe(TokenCount.of("one").total);
	});

	test("an id it does not hold costs nothing instead of throwing", () => {
		const corpus = new DecisionCorpus(ENTRIES);

		expect(corpus.tokensOf(["gone"]).total).toBe(0);
	});

	test("an empty corpus totals zero", () => {
		expect(new DecisionCorpus([]).total.total).toBe(0);
	});
});

const FILES = [
	{ path: "src/one.ts", text: "reconcile hooks everywhere the same word" },
	{ path: "src/two.ts", text: "reconcile only" },
	{ path: "src/three.ts", text: "unrelated" },
];

describe("RepositoryCorpus", () => {
	test("knows how much text the repository holds", () => {
		const repository = new RepositoryCorpus(FILES);

		expect(repository.files).toBe(3);
		expect(repository.total.total).toBe(
			TokenCount.sum(FILES.map((file) => TokenCount.of(file.text))).total,
		);
	});

	test("matching ignores case", () => {
		const repository = new RepositoryCorpus(FILES);

		expect(repository.grepCosts(["RECONCILE"]).best.files).toBe(2);
	});

	test("the narrowest term is the cheapest one that matches anything", () => {
		const costs = new RepositoryCorpus(FILES).grepCosts([
			"reconcile",
			"hooks",
			"absent",
		]);

		expect(costs.best.files).toBe(1);
		expect(costs.best.tokens.total).toBe(
			TokenCount.of(FILES[0]?.text ?? "").total,
		);
	});

	test("the median term is the upper middle by cost", () => {
		const costs = new RepositoryCorpus(FILES).grepCosts([
			"hooks",
			"reconcile",
			"unrelated",
		]);

		expect(costs.median.files).toBe(1);
		expect(costs.median.tokens.total).toBeGreaterThan(0);
	});

	test("terms nothing matches cost nothing at all", () => {
		const costs = new RepositoryCorpus(FILES).grepCosts(["absent"]);

		expect(costs.best).toEqual({ files: 0, tokens: TokenCount.zero() });
		expect(costs.median.files).toBe(0);
	});

	// "Narrowest" is what the report has always called this number and what the
	// file count printed beside it claims; ordering by tokens instead could name
	// a term matching three files the narrowest of a pair.
	test("the narrowest term is the one matching the fewest files", () => {
		const spread = new RepositoryCorpus([
			{ path: "one.ts", text: `solo ${"word ".repeat(200)}` },
			{ path: "two.ts", text: "many" },
			{ path: "three.ts", text: "many" },
			{ path: "four.ts", text: "many" },
		]);

		expect(spread.grepCosts(["solo", "many"]).best.files).toBe(1);
	});

	test("terms matching the same number of files are ordered by what they cost", () => {
		const tie = new RepositoryCorpus([
			{ path: "long.ts", text: `wide ${"word ".repeat(200)}` },
			{ path: "short.ts", text: "narrow" },
		]);

		expect(tie.grepCosts(["wide", "narrow"]).best.tokens.total).toBe(
			TokenCount.of("narrow").total,
		);
	});
});
