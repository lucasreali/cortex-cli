import { describe, expect, test } from "bun:test";
import { DecisionCorpus } from "@/benchmark/decision-corpus";
import {
	type BenchmarkReport,
	measureBenchmark,
	type RetrievalPath,
} from "@/benchmark/measure";
import { questionsFromDecisions } from "@/benchmark/questions";
import {
	formatBenchmarkMarkdown,
	formatBenchmarkTable,
} from "@/benchmark/report";
import { RepositoryCorpus } from "@/benchmark/repository-corpus";
import { TokenCount } from "@/benchmark/token-count";

const DECISIONS = [
	{ id: "d2", title: "hooks reconcile after merge", body: "" },
	{ id: "d1", title: "search degrades to full text", body: "" },
];

const CORPUS = new DecisionCorpus([
	{ id: "d1", text: "search degrades to full text when the model is cold" },
	{ id: "d2", text: "hooks reconcile after merge and after commit" },
]);

const REPOSITORY = new RepositoryCorpus([
	{ path: "a.ts", text: "search everywhere in this longer file about text" },
	{ path: "b.ts", text: "hooks here" },
	{ path: "c.ts", text: "nothing relevant" },
]);

function retrieval(answers: Record<string, string[]>): RetrievalPath {
	return {
		name: "test",
		retrieve: (query) => Promise.resolve(answers[query] ?? []),
		termsOf: (query) => query.split(" ").filter((term) => term.length >= 4),
	};
}

function measure(answers: Record<string, string[]>): Promise<BenchmarkReport> {
	return measureBenchmark(
		"project",
		questionsFromDecisions(DECISIONS, null),
		{ decisions: CORPUS, repository: REPOSITORY },
		retrieval(answers),
	);
}

describe("questionsFromDecisions", () => {
	test("one question per decision, its title, ordered by id", () => {
		expect(questionsFromDecisions(DECISIONS, null)).toEqual([
			{ id: "d1", query: "search degrades to full text", expected: "d1" },
			{ id: "d2", query: "hooks reconcile after merge", expected: "d2" },
		]);
	});

	test("a limit takes the first questions, deterministically", () => {
		expect(questionsFromDecisions(DECISIONS, 1).map((one) => one.id)).toEqual([
			"d1",
		]);
	});

	test("a limit below one asks nothing", () => {
		expect(questionsFromDecisions(DECISIONS, 0)).toEqual([]);
	});
});

describe("measureBenchmark", () => {
	test("charges an answer the full text of the decisions it names", async () => {
		const report = await measure({ "search degrades to full text": ["d1"] });
		const d1 = CORPUS.tokensOf(["d1"]).total;

		expect(report.cases[0]?.answerTokens).toBe(d1);
		expect(report.answer.meanTokens).toBe(d1 / 2);
	});

	test("the corpus baseline is the whole of it, every question", async () => {
		const report = await measure({});

		expect(report.corpus).toEqual({ decisions: 2, tokens: CORPUS.total.total });
		expect(report.repository).toEqual({
			files: 3,
			tokens: REPOSITORY.total.total,
		});
	});

	test("a hit is the decision the question came from coming back", async () => {
		const report = await measure({
			"search degrades to full text": ["d2", "d1"],
			"hooks reconcile after merge": ["d1"],
		});

		expect(report.cases.map((one) => one.hit)).toEqual([true, false]);
		expect(report.hitRate).toBe(0.5);
	});

	test("an answer nobody can give is not an infinite saving", async () => {
		const report = await measure({});

		expect(report.answer.meanTokens).toBe(0);
		expect(report.economy.corpusPerAnswer).toBe(0);
		expect(report.economy.grepBestPerAnswer).toBe(0);
		expect(report.economy.grepMedianPerAnswer).toBe(0);
	});

	test("no questions leaves every mean at zero", async () => {
		const report = await measureBenchmark(
			"project",
			[],
			{ decisions: CORPUS, repository: REPOSITORY },
			retrieval({}),
		);

		expect(report.questions).toBe(0);
		expect(report.hitRate).toBe(0);
		expect(report.grepBest.meanFiles).toBe(0);
	});

	test("the grep baseline costs whole files, per term", async () => {
		const report = await measure({ "search degrades to full text": ["d1"] });
		const searched = TokenCount.of(
			"search everywhere in this longer file about text",
		).total;

		expect(report.cases[0]?.grepBest).toEqual({ files: 1, tokens: searched });
	});

	test("the report names the method and the retrieval path", async () => {
		const report = await measure({});

		expect(report.method.id).toBe("atoms-per-5-bytes/v1");
		expect(report.retrieval).toBe("test");
		expect(report.project).toBe("project");
	});
});

describe("benchmark report", () => {
	test("the table prints one row per baseline and the hit rate", async () => {
		const report = await measure({ "search degrades to full text": ["d1"] });
		const table = formatBenchmarkTable(report);

		expect(table).toContain("whole decision corpus (2 decisions)");
		expect(table).toContain("repository grep, median keyword");
		expect(table).toContain("repository grep, narrowest keyword");
		expect(table).toContain("cortex answer");
		expect(table).toContain("self-retrieval hit rate 0.500 (1/2)");
	});

	test("the table is ascii, so no console can garble it", async () => {
		const report = await measure({ "search degrades to full text": ["d1"] });

		expect(formatBenchmarkTable(report)).toMatch(/^[\x20-\x7e\n]*$/);
	});

	test("the markdown states method, corpus size and date", async () => {
		const report = await measure({ "search degrades to full text": ["d1"] });
		const markdown = formatBenchmarkMarkdown(report, {
			date: "2026-08-15",
			version: "9.9.9",
		});

		expect(markdown).toContain("# Benchmarks");
		expect(markdown).toContain("on 2026-08-15 with cortex 9.9.9");
		expect(markdown).toContain("2 decisions");
		expect(markdown).toContain("atoms-per-5-bytes/v1");
		expect(markdown).toContain("| --- | ---: | ---: |");
		expect(markdown).toContain("## What this does not measure");
	});

	test("the markdown is ascii too", async () => {
		const report = await measure({});
		const markdown = formatBenchmarkMarkdown(report, {
			date: "2026-08-15",
			version: "9.9.9",
		});

		expect(markdown).toMatch(/^[\x20-\x7e\n]*$/);
	});
});
